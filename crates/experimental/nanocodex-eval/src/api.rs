use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead as _, BufReader, Read as _, Seek as _, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension as _};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest as _, Sha256};

const LEDGER_FILE: &str = "state.sqlite3";
const API_SCHEMA_VERSION: u32 = 2;
const MAX_EVENT_LINE_BYTES: usize = 8 * 1024 * 1024;
const OUTCOME_TAIL_BYTES: u64 = 512 * 1024;

#[derive(Clone)]
pub(crate) struct EvalApi {
    ledger: PathBuf,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvalSummary {
    total: u64,
    unclaimed: u64,
    running: u64,
    success: u64,
    failed: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvalOverview {
    schema_version: u32,
    observed_at_ms: i64,
    summary: EvalSummary,
    worksets: Vec<WorksetOverview>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorksetOverview {
    id: String,
    profile: String,
    digest: String,
    created_at_ms: i64,
    task_count: u64,
    summary: EvalSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorksetDetail {
    schema_version: u32,
    observed_at_ms: i64,
    workset: WorksetOverview,
    tasks: Vec<TaskOverview>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskOverview {
    id: String,
    name: String,
    label: String,
    digest: String,
    treatment_count: u64,
    summary: EvalSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskDetail {
    schema_version: u32,
    observed_at_ms: i64,
    workset_id: String,
    task: TaskMatrix,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskOutcomesPage {
    schema_version: u32,
    observed_at_ms: i64,
    workset_id: String,
    task_id: String,
    total: usize,
    next_cursor: Option<usize>,
    outcomes: Vec<CoordinateOutcome>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoordinateOutcome {
    id: String,
    status: Option<String>,
    outcome: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskMatrix {
    id: String,
    name: String,
    label: String,
    digest: String,
    treatments: Vec<TreatmentDetail>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreatmentDetail {
    id: String,
    label: String,
    harness: String,
    model: String,
    thinking: String,
    cells: Vec<CoordinateDetail>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoordinateDetail {
    id: String,
    repetition: u16,
    state: &'static str,
    status: Option<String>,
    outcome: Option<String>,
    updated_at_ms: Option<i64>,
    duration_ms: Option<i64>,
    message: Option<String>,
    detail_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaseEvidence {
    schema_version: u32,
    task_name: Option<String>,
    prompt: Option<String>,
    status: Option<String>,
    outcome: Option<String>,
    environment: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    final_message: Option<String>,
    tool_calls: Option<u64>,
    usage: Option<Value>,
    verifier: Option<Value>,
    exception: Option<Value>,
    timing: Option<Value>,
    verifier_stdout: Option<String>,
    verifier_stderr: Option<String>,
}

#[derive(Debug)]
struct WorksetRow {
    id: i64,
    profile: String,
    digest: String,
    created_at_ms: i64,
}

#[derive(Debug)]
struct TaskRow {
    id: i64,
    name: String,
    digest: String,
}

#[derive(Debug)]
struct CoordinateRow {
    id: i64,
    family_key: String,
    treatment: String,
    repetition: u16,
    state: String,
    result_path: Option<PathBuf>,
    started_at_ms: Option<i64>,
    finished_at_ms: Option<i64>,
    error: Option<String>,
    task_name: String,
    task_digest: String,
}

#[derive(Debug, Default)]
struct Treatment {
    harness: String,
    mode: String,
    model: String,
    thinking: String,
    nanocodex_tool_mode: String,
    codex_tool_mode: String,
}

impl EvalApi {
    pub(crate) fn new(state_directory: &Path) -> Self {
        Self {
            ledger: state_directory.join(LEDGER_FILE),
        }
    }

    pub(crate) fn overview(&self) -> Result<EvalOverview, String> {
        let connection = self.connection()?;
        let now = now_ms()?;
        let worksets = read_worksets(&connection)?;
        let mut total = EvalSummary::default();
        let mut overview = Vec::with_capacity(worksets.len());
        for workset in worksets {
            let coordinates = read_coordinates(&connection, workset.id, None)?;
            let summary = summarize(&coordinates)?;
            add_summary(&mut total, &summary);
            let task_count = u64::try_from(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM task_definitions WHERE workset_id = ?1",
                        [workset.id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            overview.push(WorksetOverview {
                id: workset.digest.clone(),
                profile: workset.profile,
                digest: workset.digest,
                created_at_ms: workset.created_at_ms,
                task_count,
                summary,
            });
        }
        Ok(EvalOverview {
            schema_version: API_SCHEMA_VERSION,
            observed_at_ms: now,
            summary: total,
            worksets: overview,
        })
    }

    pub(crate) fn workset(&self, digest: &str) -> Result<Option<WorksetDetail>, String> {
        let connection = self.connection()?;
        let Some(workset) = find_workset(&connection, digest)? else {
            return Ok(None);
        };
        let now = now_ms()?;
        let coordinates = read_coordinates(&connection, workset.id, None)?;
        let summary = summarize(&coordinates)?;
        let task_count = coordinates
            .iter()
            .map(|coordinate| coordinate.task_name.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len();
        let workset_overview = WorksetOverview {
            id: workset.digest.clone(),
            profile: workset.profile,
            digest: workset.digest.clone(),
            created_at_ms: workset.created_at_ms,
            task_count: u64::try_from(task_count).map_err(|error| error.to_string())?,
            summary,
        };
        let mut grouped = HashMap::<String, Vec<CoordinateRow>>::new();
        for coordinate in coordinates {
            grouped
                .entry(coordinate.task_name.clone())
                .or_default()
                .push(coordinate);
        }
        let mut tasks = grouped
            .into_iter()
            .map(|(name, coordinates)| {
                let digest = coordinates[0].task_digest.clone();
                let treatment_count = coordinates
                    .iter()
                    .map(|coordinate| coordinate.family_key.as_str())
                    .collect::<std::collections::HashSet<_>>()
                    .len();
                Ok(TaskOverview {
                    id: public_id(&[&workset.digest, &name]),
                    label: short_name(&name).to_owned(),
                    name,
                    digest,
                    treatment_count: u64::try_from(treatment_count)
                        .map_err(|error| error.to_string())?,
                    summary: summarize(&coordinates)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        tasks.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(Some(WorksetDetail {
            schema_version: API_SCHEMA_VERSION,
            observed_at_ms: now,
            workset: workset_overview,
            tasks,
        }))
    }

    pub(crate) fn task(
        &self,
        workset_digest: &str,
        task_id: &str,
    ) -> Result<Option<TaskDetail>, String> {
        let connection = self.connection()?;
        let Some(workset) = find_workset(&connection, workset_digest)? else {
            return Ok(None);
        };
        let Some(task) = find_task(&connection, workset.id, workset_digest, task_id)? else {
            return Ok(None);
        };
        let now = now_ms()?;
        let mut coordinates = read_coordinates(&connection, workset.id, Some(task.id))?;
        let mut treatments = Vec::<TreatmentDetail>::new();
        for coordinate in coordinates.drain(..) {
            let treatment = parse_treatment(&coordinate.treatment);
            let state = coordinate_state(&coordinate);
            let cell = CoordinateDetail {
                id: case_id(workset_digest, coordinate.id),
                repetition: coordinate.repetition,
                state,
                status: None,
                outcome: None,
                updated_at_ms: coordinate.finished_at_ms.or(coordinate.started_at_ms),
                duration_ms: coordinate
                    .finished_at_ms
                    .zip(coordinate.started_at_ms)
                    .map(|(finished, started)| finished.saturating_sub(started)),
                message: coordinate.error.clone(),
                detail_id: result_path(&coordinate).map(|_| case_id(workset_digest, coordinate.id)),
            };
            let treatment_id = public_id(&[workset_digest, &coordinate.family_key]);
            if let Some(row) = treatments.iter_mut().find(|row| row.id == treatment_id) {
                row.cells.push(cell);
            } else {
                treatments.push(TreatmentDetail {
                    id: treatment_id,
                    label: treatment_label(&treatment),
                    harness: treatment_harness(&treatment),
                    model: treatment.model,
                    thinking: treatment.thinking,
                    cells: vec![cell],
                });
            }
        }
        treatments.sort_by(|left, right| left.label.cmp(&right.label));
        for treatment in &mut treatments {
            treatment.cells.sort_by_key(|cell| cell.repetition);
        }
        Ok(Some(TaskDetail {
            schema_version: API_SCHEMA_VERSION,
            observed_at_ms: now,
            workset_id: workset.digest,
            task: TaskMatrix {
                id: task_id.to_owned(),
                label: short_name(&task.name).to_owned(),
                name: task.name,
                digest: task.digest,
                treatments,
            },
        }))
    }

    pub(crate) fn task_outcomes(
        &self,
        workset_digest: &str,
        task_id: &str,
        cursor: usize,
        limit: usize,
    ) -> Result<Option<TaskOutcomesPage>, String> {
        let connection = self.connection()?;
        let Some(workset) = find_workset(&connection, workset_digest)? else {
            return Ok(None);
        };
        let Some(task) = find_task(&connection, workset.id, workset_digest, task_id)? else {
            return Ok(None);
        };
        let coordinates = read_coordinates(&connection, workset.id, Some(task.id))?
            .into_iter()
            .filter(|coordinate| {
                matches!(coordinate.state.as_str(), "success" | "failed")
                    && result_path(coordinate).is_some()
            })
            .collect::<Vec<_>>();
        let total = coordinates.len();
        let mut outcomes = Vec::with_capacity(limit.min(total.saturating_sub(cursor)));
        for coordinate in coordinates.into_iter().skip(cursor).take(limit) {
            let evidence = self.outcome_for(&coordinate)?;
            outcomes.push(CoordinateOutcome {
                id: case_id(workset_digest, coordinate.id),
                status: evidence.as_ref().and_then(|value| value.status.clone()),
                outcome: evidence.and_then(|value| value.outcome),
            });
        }
        let loaded = cursor.saturating_add(outcomes.len());
        Ok(Some(TaskOutcomesPage {
            schema_version: API_SCHEMA_VERSION,
            observed_at_ms: now_ms()?,
            workset_id: workset.digest,
            task_id: task_id.to_owned(),
            total,
            next_cursor: (loaded < total).then_some(loaded),
            outcomes,
        }))
    }

    pub(crate) fn case(&self, id: &str) -> Result<Option<CaseEvidence>, String> {
        let connection = self.connection()?;
        for workset in read_worksets(&connection)? {
            for coordinate in read_coordinates(&connection, workset.id, None)? {
                if case_id(&workset.digest, coordinate.id) == id {
                    return self.evidence_for(&coordinate);
                }
            }
        }
        Ok(None)
    }

    fn connection(&self) -> Result<Connection, String> {
        let connection = Connection::open_with_flags(
            &self.ledger,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| error.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }

    fn evidence_for(&self, coordinate: &CoordinateRow) -> Result<Option<CaseEvidence>, String> {
        let Some(result_path) = result_path(coordinate) else {
            return Ok(None);
        };
        let result = match result_path.canonicalize() {
            Ok(result) => result,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        read_evidence(&result)
    }

    fn outcome_for(&self, coordinate: &CoordinateRow) -> Result<Option<CaseEvidence>, String> {
        let Some(result_path) = result_path(coordinate) else {
            return Ok(None);
        };
        let result = match result_path.canonicalize() {
            Ok(result) => result,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        read_outcome(&result)
    }
}

const fn result_path(coordinate: &CoordinateRow) -> Option<&PathBuf> {
    coordinate.result_path.as_ref()
}

fn summarize(coordinates: &[CoordinateRow]) -> Result<EvalSummary, String> {
    let mut summary = EvalSummary {
        total: u64::try_from(coordinates.len()).map_err(|error| error.to_string())?,
        ..EvalSummary::default()
    };
    for coordinate in coordinates {
        match coordinate_state(coordinate) {
            "unclaimed" => summary.unclaimed += 1,
            "running" => summary.running += 1,
            "success" => summary.success += 1,
            "failed" => summary.failed += 1,
            _ => return Err(format!("unknown durable task state `{}`", coordinate.state)),
        }
    }
    Ok(summary)
}

fn read_worksets(connection: &Connection) -> Result<Vec<WorksetRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, profile, digest, created_at_ms FROM worksets \
             ORDER BY created_at_ms DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    statement
        .query_map([], |row| {
            Ok(WorksetRow {
                id: row.get(0)?,
                profile: row.get(1)?,
                digest: row.get(2)?,
                created_at_ms: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn find_workset(connection: &Connection, digest: &str) -> Result<Option<WorksetRow>, String> {
    connection
        .query_row(
            "SELECT id, profile, digest, created_at_ms FROM worksets WHERE digest = ?1",
            [digest],
            |row| {
                Ok(WorksetRow {
                    id: row.get(0)?,
                    profile: row.get(1)?,
                    digest: row.get(2)?,
                    created_at_ms: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn find_task(
    connection: &Connection,
    workset_id: i64,
    workset_digest: &str,
    public_task_id: &str,
) -> Result<Option<TaskRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, selector, digest FROM task_definitions WHERE workset_id = ?1 ORDER BY id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([workset_id], |row| {
            Ok(TaskRow {
                id: row.get(0)?,
                name: row.get(1)?,
                digest: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let task = row.map_err(|error| error.to_string())?;
        if public_id(&[workset_digest, &task.name]) == public_task_id {
            return Ok(Some(task));
        }
    }
    Ok(None)
}

fn read_coordinates(
    connection: &Connection,
    workset_id: i64,
    task_id: Option<i64>,
) -> Result<Vec<CoordinateRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT e.id, e.family_key, e.treatment, e.repetition, e.state, \
                    e.result_path, e.started_at_ms, e.finished_at_ms, e.error, \
                    t.selector, t.digest \
             FROM eval_tasks e JOIN task_definitions t ON t.id = e.definition_id \
             WHERE e.workset_id = ?1 AND (?2 IS NULL OR e.definition_id = ?2) \
             ORDER BY t.selector, e.family_key, e.repetition",
        )
        .map_err(|error| error.to_string())?;
    let coordinates = statement
        .query_map((workset_id, task_id), |row| {
            Ok(CoordinateRow {
                id: row.get(0)?,
                family_key: row.get(1)?,
                treatment: row.get(2)?,
                repetition: row.get(3)?,
                state: row.get(4)?,
                result_path: row.get::<_, Option<String>>(5)?.map(PathBuf::from),
                started_at_ms: row.get(6)?,
                finished_at_ms: row.get(7)?,
                error: row.get(8)?,
                task_name: row.get(9)?,
                task_digest: row.get(10)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(coordinates)
}

fn coordinate_state(coordinate: &CoordinateRow) -> &'static str {
    match coordinate.state.as_str() {
        "unclaimed" => "unclaimed",
        "running" => "running",
        "success" => "success",
        "failed" => "failed",
        _ => "failed",
    }
}

fn read_evidence(result: &Path) -> Result<Option<CaseEvidence>, String> {
    let Some(events) = events_path(result) else {
        return Ok(None);
    };
    let file = match File::open(events) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut evidence = empty_evidence();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.len() > MAX_EVENT_LINE_BYTES {
            return Err("retained evaluation event exceeded the API limit".to_owned());
        }
        let event: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        match event.get("type").and_then(Value::as_str) {
            Some("attempt_started") => {
                evidence.task_name = event
                    .pointer("/attempt/task_name")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                evidence.prompt = event
                    .pointer("/payload/prompt")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            Some("verifier_output") => {
                evidence.verifier_stdout = event
                    .pointer("/payload/stdout")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                evidence.verifier_stderr = event
                    .pointer("/payload/stderr")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            Some("completed") => apply_terminal_payload(&mut evidence, &event["payload"]),
            Some("failed") => apply_terminal_payload(&mut evidence, &event["payload"]),
            _ => {}
        }
    }
    Ok((evidence.status.is_some() || evidence.outcome.is_some()).then_some(evidence))
}

fn read_outcome(result: &Path) -> Result<Option<CaseEvidence>, String> {
    let Some(events) = events_path(result) else {
        return Ok(None);
    };
    let mut file = match File::open(&events) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let start = length.saturating_sub(OUTCOME_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut tail = Vec::with_capacity(
        usize::try_from(length.saturating_sub(start)).map_err(|error| error.to_string())?,
    );
    file.read_to_end(&mut tail)
        .map_err(|error| error.to_string())?;
    let first_complete_line = if start == 0 {
        0
    } else {
        tail.iter()
            .position(|byte| *byte == b'\n')
            .map_or(tail.len(), |position| position + 1)
    };
    for line in tail[first_complete_line..]
        .split(|byte| *byte == b'\n')
        .rev()
        .filter(|line| !line.is_empty())
    {
        if line.len() > MAX_EVENT_LINE_BYTES {
            return Err("retained evaluation event exceeded the API limit".to_owned());
        }
        let event: Value = serde_json::from_slice(line).map_err(|error| error.to_string())?;
        if matches!(
            event.get("type").and_then(Value::as_str),
            Some("completed" | "failed")
        ) {
            let mut evidence = empty_evidence();
            apply_terminal_payload(&mut evidence, &event["payload"]);
            return Ok(Some(evidence));
        }
    }
    read_evidence(result)
}

fn events_path(result: &Path) -> Option<PathBuf> {
    if result.is_dir() {
        Some(result.join("events.jsonl"))
    } else if result
        .file_name()
        .is_some_and(|name| name == "events.jsonl")
    {
        Some(result.to_path_buf())
    } else if result.is_file() {
        result.parent().map(|parent| parent.join("events.jsonl"))
    } else {
        None
    }
}

const fn empty_evidence() -> CaseEvidence {
    CaseEvidence {
        schema_version: API_SCHEMA_VERSION,
        task_name: None,
        prompt: None,
        status: None,
        outcome: None,
        environment: None,
        model: None,
        effort: None,
        final_message: None,
        tool_calls: None,
        usage: None,
        verifier: None,
        exception: None,
        timing: None,
        verifier_stdout: None,
        verifier_stderr: None,
    }
}

fn apply_terminal_payload(evidence: &mut CaseEvidence, payload: &Value) {
    evidence.task_name = payload
        .get("task_name")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| evidence.task_name.take());
    evidence.status = payload
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_owned);
    evidence.outcome = payload
        .get("outcome")
        .and_then(Value::as_str)
        .map(str::to_owned);
    evidence.environment = payload
        .get("environment")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let agent = payload.get("agent").filter(|value| value.is_object());
    evidence.model = agent
        .and_then(|value| value.get("model"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            payload
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    evidence.effort = agent
        .and_then(|value| value.get("effort"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            payload
                .get("effort")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    evidence.final_message = agent
        .and_then(|value| value.get("final_message"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    evidence.tool_calls = agent
        .and_then(|value| value.get("tool_calls"))
        .and_then(Value::as_u64);
    evidence.usage = agent.and_then(|value| value.get("usage")).cloned();
    evidence.verifier = payload
        .get("verifier")
        .filter(|value| value.is_object())
        .cloned();
    evidence.exception = payload
        .get("exception")
        .filter(|value| !value.is_null())
        .cloned();
    evidence.timing = payload
        .get("timing")
        .filter(|value| value.is_object())
        .cloned();
}

fn parse_treatment(raw: &str) -> Treatment {
    let value = serde_json::from_str::<Value>(raw).unwrap_or(Value::Null);
    let string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Treatment {
        harness: string("harness"),
        mode: string("mode"),
        model: string("model"),
        thinking: string("thinking"),
        nanocodex_tool_mode: string("nanocodex_tool_mode"),
        codex_tool_mode: string("codex_tool_mode"),
    }
}

fn treatment_harness(treatment: &Treatment) -> String {
    if !treatment.harness.is_empty() {
        treatment.harness.clone()
    } else if !treatment.mode.is_empty() {
        treatment.mode.clone()
    } else {
        "unknown".to_owned()
    }
}

fn treatment_label(treatment: &Treatment) -> String {
    let mut parts = [
        treatment_harness(treatment),
        treatment.model.clone(),
        treatment.thinking.clone(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>();
    if !treatment.nanocodex_tool_mode.is_empty() || !treatment.codex_tool_mode.is_empty() {
        let tools = if treatment.nanocodex_tool_mode == treatment.codex_tool_mode {
            treatment.nanocodex_tool_mode.clone()
        } else {
            format!(
                "N:{} / C:{}",
                treatment.nanocodex_tool_mode, treatment.codex_tool_mode
            )
        };
        if !tools.is_empty() {
            parts.push(tools);
        }
    }
    parts.join(" · ")
}

const fn add_summary(total: &mut EvalSummary, summary: &EvalSummary) {
    total.total += summary.total;
    total.unclaimed += summary.unclaimed;
    total.running += summary.running;
    total.success += summary.success;
    total.failed += summary.failed;
}

fn short_name(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

fn case_id(workset_digest: &str, coordinate_id: i64) -> String {
    public_id(&[workset_digest, &coordinate_id.to_string()])
}

fn public_id(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    hex::encode(digest.finalize())[..24].to_owned()
}

fn now_ms() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|error| error.to_string())
}
