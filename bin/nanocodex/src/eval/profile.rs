use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use clap::Args;
use eyre::{Result, WrapErr as _, eyre};
use fs2::FileExt as _;
use nanocodex::{Model, Thinking};
use nanocodex_eval::{
    EvalAttemptOutcome, EvalEventKind, EvalEventStream, EvalOutcome, EvalStatus, Evaluation,
    EvaluationClaim, EvaluationSelector, EvaluationWork, Evaluator, ResolvedHarness, Task,
    atif::AtifBuilder,
    coordinator::{CoordinatorClient, RemoteClaim},
    harness::{Harness, HarnessAuth},
    judge::JudgeRuntime,
    vm::{CachePolicy, VmBackend, VmResources},
};
use nanocodex_eval_adapters::AdapterCatalog;
use serde::Serialize;
use tokio::io::AsyncWriteExt as _;

use super::run;
use crate::{
    config::{EvalAgentArgs, SharedAuth},
    observability::ObservabilityArgs,
};

const CONFIG_FILE: &str = "nanocodex.toml";
const WORKER_DIRECTORY_PREFIX: &str = "nanocodex-eval-worker-";
const ABANDONED_WORKER_AGE: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Clone, Debug, Args)]
pub(super) struct ProfileTarget {
    /// Named benchmark stored in SQLite. Uses its newest generation.
    profile: String,

    /// Runtime harness helper configuration. SQLite owns desired work.
    #[arg(long, default_value = CONFIG_FILE)]
    config: PathBuf,

    /// Durable SQLite ledger and retained artifacts.
    ///
    /// Defaults to ~/.nanocodex/evals.
    #[arg(long, value_name = "DIRECTORY")]
    state_dir: Option<PathBuf>,

    /// Pull claims from a remote coordinator instead of opening SQLite directly.
    #[arg(long, value_name = "URL", conflicts_with = "state_dir")]
    coordinator: Option<String>,
}

#[derive(Args)]
pub(super) struct Add {
    /// Named benchmark to create or extend.
    profile: String,

    /// Expand one optional TOML profile recipe into SQLite.
    #[arg(long, value_name = "NAME")]
    recipe: Option<String>,

    /// Task package to add. Repeat to add multiple tasks.
    #[arg(long, value_name = "PATH")]
    task: Vec<PathBuf>,

    /// Harness name to add. Repeat to create a matrix.
    #[arg(long, value_name = "NAME")]
    harness: Vec<String>,

    /// Model to add. Repeat to create a matrix.
    #[arg(long)]
    model: Vec<Model>,

    /// Reasoning effort to add. Repeat to create a matrix.
    #[arg(long)]
    thinking: Vec<Thinking>,

    /// Number of rows to materialize for every treatment.
    #[arg(long, default_value_t = 1)]
    trials: u16,

    /// Enable model-facing web search for these rows.
    #[arg(long)]
    web_search: bool,

    /// Start a fresh generation instead of extending the newest one.
    #[arg(long)]
    new: bool,

    /// Optional profile recipes and runtime harness helpers.
    #[arg(long, default_value = CONFIG_FILE)]
    config: PathBuf,

    /// Durable SQLite ledger and retained artifacts.
    #[arg(long, value_name = "DIRECTORY")]
    state_dir: Option<PathBuf>,
}

#[derive(Args)]
pub(super) struct Status {
    #[command(flatten)]
    target: ProfileTarget,

    /// Print the complete machine-readable profile ledger.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
pub(super) struct Run {
    #[command(flatten)]
    target: ProfileTarget,

    /// Optionally restrict the atomic claim to one exact profile task.
    #[arg(long, value_name = "TASK")]
    task: Option<String>,

    /// Select one model when the profile contains a model matrix.
    #[arg(long)]
    model: Option<Model>,

    /// Select one configured external harness. Omission uses Nanocodex.
    #[arg(long, value_name = "NAME")]
    harness: Option<String>,

    /// Advisory stable name used for coordinator task affinity and status.
    #[arg(long, env = "NANOCODEX_WORKER_NAME", value_name = "NAME")]
    worker: Option<String>,

    #[command(flatten)]
    observability: ObservabilityArgs,

    #[command(flatten)]
    agent: EvalAgentArgs,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum RunOutput<'a> {
    Completed {
        profile: &'a str,
        task: &'a str,
        repetition: u16,
        evidence: &'a str,
        status: &'a str,
    },
    InfrastructureFailed {
        profile: &'a str,
        task: &'a str,
        repetition: u16,
        error: &'a str,
    },
    AlreadyComplete {
        profile: &'a str,
        task: &'a str,
    },
    TemporarilyUnavailable {
        profile: &'a str,
        task: &'a str,
        reason: &'a str,
        retry_after_ms: u64,
    },
}

impl Add {
    pub(super) async fn run(self) -> Result<()> {
        let state = self.state_dir.map_or_else(default_state_dir, Ok)?;
        if let Some(recipe) = self.recipe.as_deref() {
            if !self.task.is_empty()
                || !self.harness.is_empty()
                || !self.model.is_empty()
                || !self.thinking.is_empty()
                || self.trials != 1
                || self.web_search
            {
                return Err(eyre!(
                    "--recipe is complete; use either --recipe or explicit work knobs"
                ));
            }
            let selectors = Evaluation::profile_benchmarks(&self.config, Some(recipe))?;
            if selectors.is_empty() {
                Evaluation::add_profile(
                    &self.config,
                    Some(recipe),
                    &state,
                    &self.profile,
                    self.new,
                )?;
            } else {
                let tasks = AdapterCatalog::new(&state)
                    .resolve(&self.config, &selectors)
                    .await?;
                Evaluation::add_profile_with_tasks(
                    &self.config,
                    Some(recipe),
                    tasks,
                    &state,
                    &self.profile,
                    self.new,
                )?;
            }
        } else {
            if self.task.is_empty() {
                return Err(eyre!("at least one --task or --recipe is required"));
            }
            let harnesses = if self.harness.is_empty() {
                vec!["nanocodex".to_owned()]
            } else {
                self.harness
            };
            let models = if self.model.is_empty() {
                vec![Model::default()]
            } else {
                self.model
            };
            let thinking = if self.thinking.is_empty() {
                vec![Thinking::default()]
            } else {
                self.thinking
            };
            let mut work = Vec::new();
            for path in self.task {
                let selector = path.to_string_lossy().into_owned();
                let task = Task::load(&path)?;
                for harness in &harnesses {
                    for model in &models {
                        for thinking in &thinking {
                            work.push(
                                EvaluationWork::new(&selector, task.clone())
                                    .harness(harness)
                                    .model(*model)
                                    .thinking(*thinking)
                                    .web_search(self.web_search)
                                    .trials(self.trials),
                            );
                        }
                    }
                }
            }
            Evaluation::add(&state, &self.profile, &work, self.new)?;
        }
        let status = Evaluation::open(&self.config, Some(&self.profile), state)?.status()?;
        println!(
            "{} {} · {} pre-materialized task row(s)",
            status.profile,
            &status.digest[..status.digest.len().min(12)],
            status.tasks.total()
        );
        Ok(())
    }
}

impl Status {
    pub(super) async fn run(self) -> Result<()> {
        if let Some(coordinator) = &self.target.coordinator {
            let status = CoordinatorClient::new(coordinator)?.status().await?;
            if self.json {
                serde_json::to_writer_pretty(std::io::stdout().lock(), &status)?;
                println!();
            } else {
                print_remote_status(&status);
            }
            return Ok(());
        }
        let evaluation = self.target.open()?;
        let status = evaluation.status()?;
        if self.json {
            serde_json::to_writer_pretty(std::io::stdout().lock(), &status)?;
            println!();
        } else {
            println!(
                "{} {} · tasks {}/{} finished · {} running · {} failed",
                status.profile,
                &status.digest[..12],
                status.tasks.finished(),
                status.tasks.total(),
                status.tasks.running,
                status.tasks.failed,
            );
            for family in status.families {
                println!(
                    "  {} · {} success · {} failed · {} running · {} unclaimed",
                    family.task, family.success, family.failed, family.running, family.unclaimed
                );
            }
        }
        Ok(())
    }
}

impl Run {
    pub(super) async fn run(self) -> Result<()> {
        let _observability = self.observability.install(false, Path::new("."))?;
        let requested_thinking = self.agent.thinking();
        let selector = self.task.as_ref().map(|task| {
            EvaluationSelector::new(task)
                .harness(self.harness.clone())
                .model(self.model)
                .thinking(requested_thinking)
        });
        if selector.is_none() && (self.harness.is_some() || self.model.is_some()) {
            return Err(eyre!("--harness and --model require --task"));
        }
        if let Some(coordinator) = &self.target.coordinator {
            let mut coordinator = CoordinatorClient::new(coordinator)?;
            if let Some(worker) = self.worker {
                coordinator = coordinator.worker(worker);
            }
            return run_remote(
                coordinator,
                selector,
                &self.target.config,
                &self.target.profile,
                self.agent,
            )
            .await;
        }
        let evaluation = self.target.open()?;
        let next = match &selector {
            Some(selector) => evaluation.claim(selector)?,
            None => evaluation.claim_next()?,
        };
        match next {
            EvaluationClaim::Run(claim) => {
                let repetition = claim.repetition();
                let task_selector = claim.task_selector().to_owned();
                let result = async {
                    let resources = prepare_resources(claim.task(), claim.harnesses()).await?;
                    execute_coordinate(
                        claim.task().clone(),
                        claim.treatment().clone(),
                        claim.web_search(),
                        claim.harness().cloned(),
                        claim.output_directory().to_path_buf(),
                        resources,
                        self.agent,
                    )
                    .await
                }
                .await;
                match result {
                    Ok(ExecutionResult::Completed { status, evidence }) => {
                        let status_name = eval_status_name(status);
                        match status {
                            EvalStatus::Passed => claim.succeed(&evidence)?,
                            EvalStatus::Failed => {
                                claim.fail(Some(&evidence), "verifier returned a failing score")?
                            }
                        }
                        let evidence = evidence.to_string_lossy();
                        write_json(&RunOutput::Completed {
                            profile: evaluation.name(),
                            task: &task_selector,
                            repetition,
                            evidence: &evidence,
                            status: status_name,
                        })?;
                        Ok(())
                    }
                    Ok(ExecutionResult::InfrastructureFailed { error, evidence }) => {
                        claim.retry(Some(&evidence), &error)?;
                        write_json(&RunOutput::InfrastructureFailed {
                            profile: evaluation.name(),
                            task: &task_selector,
                            repetition,
                            error: &error,
                        })?;
                        Err(eyre!(
                            "task infrastructure failed; evidence retained at {} and row requeued: {error}",
                            evidence.display()
                        ))
                    }
                    Err(error) => {
                        let message = format!("{error:#}");
                        claim.retry(None, &message)?;
                        write_json(&RunOutput::InfrastructureFailed {
                            profile: evaluation.name(),
                            task: &task_selector,
                            repetition,
                            error: &message,
                        })?;
                        Err(error).wrap_err("task infrastructure failed and row was requeued")
                    }
                }
            }
            EvaluationClaim::Busy(busy) => {
                write_json(&RunOutput::TemporarilyUnavailable {
                    profile: evaluation.name(),
                    task: self.task.as_deref().unwrap_or("any"),
                    reason: busy.reason,
                    retry_after_ms: busy.retry_after_ms,
                })?;
                Err(eyre!(
                    "temporarily unavailable: {}; retry after {} ms",
                    busy.reason,
                    busy.retry_after_ms
                ))
            }
            EvaluationClaim::Complete => {
                write_json(&RunOutput::AlreadyComplete {
                    profile: evaluation.name(),
                    task: self.task.as_deref().unwrap_or("any"),
                })?;
                Ok(())
            }
        }
    }
}

async fn run_remote(
    coordinator: CoordinatorClient,
    selector: Option<EvaluationSelector>,
    config: &Path,
    profile: &str,
    agent: EvalAgentArgs,
) -> Result<()> {
    let remote_claim = match &selector {
        Some(selector) => coordinator.claim(selector).await?,
        None => coordinator.claim_next().await?,
    };
    match remote_claim {
        RemoteClaim::Run {
            claim,
            repetition,
            task: task_selector,
            task_root,
            treatment,
            ..
        } => {
            let setup = (|| {
                validate_web_search(&agent, profile, treatment.web_search)?;
                let task = Task::load(&task_root)?;
                let harness = Evaluation::resolve_harness(config, &treatment.harness)?;
                let harnesses = harness.iter().cloned().collect::<Vec<_>>();
                let host = run::PreparedVmHost::open()?;
                reap_abandoned_worker_directories(host.cache())?;
                let output = tempfile::Builder::new()
                    .prefix(WORKER_DIRECTORY_PREFIX)
                    .tempdir_in(host.cache())?;
                let output_directory = fs::canonicalize(output.path())?;
                let output_lease = OpenOptions::new()
                    .create(true)
                    .read(true)
                    .write(true)
                    .truncate(false)
                    .open(output.path().join(".active.lock"))?;
                output_lease.lock_exclusive()?;
                Ok::<_, eyre::Report>((
                    task,
                    harness,
                    harnesses,
                    host,
                    output,
                    output_directory,
                    output_lease,
                ))
            })();
            let (task, harness, harnesses, host, _output, output_directory, _output_lease) =
                match setup {
                    Ok(setup) => setup,
                    Err(error) => {
                        let detail = format!("{error:#}");
                        let finish = coordinator.retry(&claim, &detail).await;
                        finish?;
                        return Err(error)
                            .wrap_err("remote task setup failed and row was requeued");
                    }
                };
            let execution = async {
                let resources = prepare_resources_from(&task, &harnesses, &host).await?;
                execute_coordinate(
                    task.clone(),
                    treatment.clone(),
                    treatment.web_search,
                    harness,
                    output_directory.clone(),
                    resources,
                    agent,
                )
                .await
            };
            let result = execution.await;
            match result {
                Ok(ExecutionResult::Completed { status, evidence }) => {
                    let finish = match status {
                        EvalStatus::Passed => {
                            coordinator
                                .succeed(&claim, &output_directory, &evidence)
                                .await
                        }
                        EvalStatus::Failed => {
                            coordinator
                                .fail_with_evidence(
                                    &claim,
                                    &output_directory,
                                    &evidence,
                                    "verifier returned a failing score",
                                )
                                .await
                        }
                    };
                    finish?;
                    write_json(&RunOutput::Completed {
                        profile,
                        task: &task_selector,
                        repetition,
                        evidence: "coordinator",
                        status: eval_status_name(status),
                    })?;
                    Ok(())
                }
                Ok(ExecutionResult::InfrastructureFailed { error, evidence }) => {
                    let finish = coordinator
                        .retry_with_evidence(&claim, &output_directory, &evidence, &error)
                        .await;
                    finish?;
                    write_json(&RunOutput::InfrastructureFailed {
                        profile,
                        task: &task_selector,
                        repetition,
                        error: &error,
                    })?;
                    Err(eyre!(
                        "remote task infrastructure failed and row was requeued: {error}"
                    ))
                }
                Err(error) => {
                    let finish = coordinator
                        .retry_with_evidence(
                            &claim,
                            &output_directory,
                            &output_directory,
                            &format!("{error:#}"),
                        )
                        .await;
                    finish?;
                    Err(error).wrap_err("remote task infrastructure failed and row was requeued")
                }
            }
        }
        RemoteClaim::Busy {
            reason,
            retry_after_ms,
        } => {
            write_json(&RunOutput::TemporarilyUnavailable {
                profile,
                task: "any",
                reason: &reason,
                retry_after_ms,
            })?;
            Err(eyre!(
                "temporarily unavailable: {reason}; retry after {retry_after_ms} ms"
            ))
        }
        RemoteClaim::Complete => {
            write_json(&RunOutput::AlreadyComplete {
                profile,
                task: "any",
            })?;
            Ok(())
        }
    }
}

fn reap_abandoned_worker_directories(cache: &Path) -> Result<()> {
    let now = SystemTime::now();
    let mut removed = 0_u64;
    for entry in fs::read_dir(cache)
        .wrap_err_with(|| format!("failed to inspect VM cache {}", cache.display()))?
    {
        let entry = entry?;
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(WORKER_DIRECTORY_PREFIX)
            || !entry.file_type()?.is_dir()
        {
            continue;
        }
        let modified = entry.metadata()?.modified()?;
        if now.duration_since(modified).unwrap_or_default() < ABANDONED_WORKER_AGE {
            continue;
        }
        let directory = entry.path();
        let lease = match OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.join(".active.lock"))
        {
            Ok(lease) => Some(lease),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => {
                tracing::warn!(
                    target: "nanocodex_eval",
                    worker_directory = %directory.display(),
                    %error,
                    "failed to inspect stale eval worker lease"
                );
                continue;
            }
        };
        if let Some(lease) = &lease
            && let Err(error) = lease.try_lock_exclusive()
        {
            if error.kind() != io::ErrorKind::WouldBlock {
                tracing::warn!(
                    target: "nanocodex_eval",
                    worker_directory = %directory.display(),
                    %error,
                    "failed to lock stale eval worker directory"
                );
            }
            continue;
        }
        match fs::remove_dir_all(&directory) {
            Ok(()) => removed = removed.saturating_add(1),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => tracing::warn!(
                target: "nanocodex_eval",
                worker_directory = %directory.display(),
                %error,
                "failed to remove abandoned eval worker directory"
            ),
        }
    }
    if removed > 0 {
        tracing::info!(
            target: "nanocodex_eval",
            removed,
            cache = %cache.display(),
            "removed abandoned eval worker directories"
        );
    }
    Ok(())
}

fn validate_web_search(agent: &EvalAgentArgs, profile: &str, web_search: bool) -> Result<()> {
    if agent
        .web_search()
        .is_some_and(|requested| requested != web_search)
    {
        return Err(eyre!(
            "--web-search cannot override profile `{profile}`; the profile fixes web_search={web_search}"
        ));
    }
    Ok(())
}

impl ProfileTarget {
    fn open(&self) -> Result<Evaluation> {
        let state_directory = self.state_dir.clone().map_or_else(default_state_dir, Ok)?;
        Ok(Evaluation::open(
            &self.config,
            Some(&self.profile),
            state_directory,
        )?)
    }
}

enum ExecutionResult {
    Completed {
        status: EvalStatus,
        evidence: PathBuf,
    },
    InfrastructureFailed {
        error: String,
        evidence: PathBuf,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExecutionDisposition {
    Completed(EvalStatus),
    Retry,
}

const fn eval_status_name(status: EvalStatus) -> &'static str {
    match status {
        EvalStatus::Passed => "passed",
        EvalStatus::Failed => "failed",
    }
}

fn classify_execution(outcome: &EvalAttemptOutcome, evidence: PathBuf) -> ExecutionResult {
    match execution_disposition(outcome.outcome()) {
        ExecutionDisposition::Completed(status) => ExecutionResult::Completed { status, evidence },
        ExecutionDisposition::Retry => ExecutionResult::InfrastructureFailed {
            error: outcome.exception().map_or_else(
                || "evaluation attempt was not scored".to_owned(),
                |exception| exception.traceback.clone(),
            ),
            evidence,
        },
    }
}

const fn execution_disposition(outcome: EvalOutcome) -> ExecutionDisposition {
    match outcome {
        EvalOutcome::Passed => ExecutionDisposition::Completed(EvalStatus::Passed),
        EvalOutcome::VerifierFailed | EvalOutcome::SafetyRefusal => {
            ExecutionDisposition::Completed(EvalStatus::Failed)
        }
        EvalOutcome::AgentTimeout | EvalOutcome::InfrastructureError => ExecutionDisposition::Retry,
    }
}

async fn prepare_resources(task: &Task, harnesses: &[ResolvedHarness]) -> Result<VmResources> {
    let host = run::PreparedVmHost::open()?;
    prepare_resources_from(task, harnesses, &host).await
}

async fn prepare_resources_from(
    task: &Task,
    harnesses: &[ResolvedHarness],
    host: &run::PreparedVmHost,
) -> Result<VmResources> {
    let mut builder = VmResources::builder(host.vmm(), host.runtime_image())
        .task(task.clone())
        .cache_directory(host.cache())
        .cache_policy(CachePolicy::Reuse)
        .image_preparation_concurrency(1);
    for harness in harnesses {
        builder = builder.guest_executable(&harness.command, &harness.guest_command);
    }
    let resources = builder.prepare().await?;
    // Keep image construction inside the running task's ownership lifetime.
    resources.backend().await?;
    Ok(resources)
}

async fn execute_coordinate(
    task: Task,
    treatment: nanocodex_eval::EvaluationTreatment,
    web_search: bool,
    harness: Option<ResolvedHarness>,
    output: PathBuf,
    resources: VmResources,
    agent: EvalAgentArgs,
) -> Result<ExecutionResult> {
    std::fs::create_dir_all(&output)?;
    let (nanocodex, auth) =
        agent.shared_builder(treatment.model, treatment.thinking, web_search)?;
    let judge = JudgeRuntime::start(nanocodex.clone().thinking(Thinking::Low)).await?;
    let verifier_environment = judge.verifier_environment();
    match treatment.harness.as_str() {
        "nanocodex" => {
            let backend = resources
                .backend_with(
                    VmBackend::builder()
                        .retain_passed_rootfs(false)
                        .retain_failed_rootfs(false)
                        .verifier_environment(verifier_environment),
                )
                .await?;
            let evaluator = Evaluator::builder(nanocodex, backend)
                .output_directory(&output)
                .build()?;
            let outcome = run_native(&evaluator, task).await?;
            let evidence = evaluator.directory().to_path_buf();
            Ok(classify_execution(&outcome, evidence))
        }
        _ => {
            let harness_auth = match auth {
                SharedAuth::ApiKey(api_key) => HarnessAuth::api_key(api_key),
                SharedAuth::AuthFile(path) => HarnessAuth::auth_file(path),
            };
            let configured =
                harness.ok_or_else(|| eyre!("external harness lost its resolved configuration"))?;
            let harness = Harness::new(
                nanocodex,
                task.clone(),
                &configured.command,
                &configured.guest_command,
                harness_auth,
                resources,
            )
            .model(treatment.model)
            .output_directory(&output)
            .thinking(treatment.thinking)
            .web_search(web_search)
            .guest_memory_mb(task.resources().memory_mb)
            .arguments(configured.arguments)
            .environment(configured.environment.into_iter().collect())
            .verifier_environment(verifier_environment)
            .credentials(
                configured.home,
                configured.auth_file,
                configured.api_key_environment,
            )
            .api_upstream(configured.api_upstream)
            .version(configured.version)
            .name(configured.name)
            .prepare()
            .await?;
            let outcome = run_native(harness.evaluator(), task).await?;
            harness.retain_trajectory(&outcome).await?;
            let evidence = harness.directory().to_path_buf();
            Ok(classify_execution(&outcome, evidence))
        }
    }
}

struct NativeEventRecording {
    atif: AtifBuilder,
    atif_error: Option<String>,
}

async fn run_native(evaluator: &Evaluator, task: Task) -> Result<EvalAttemptOutcome> {
    let event_log = evaluator.directory().join("events.jsonl");
    let run = evaluator.task(task);
    let stream = run.events().subscribe();
    let recorder = tokio::spawn(async move { record_native_events(stream, &event_log).await });
    let outcome = run.await;
    let recording = recorder
        .await
        .wrap_err("native event recorder task failed")??;
    let outcome = outcome?;
    retain_native_trajectory(&outcome, recording).await?;
    Ok(outcome)
}

async fn record_native_events(
    mut stream: EvalEventStream,
    path: &Path,
) -> Result<NativeEventRecording> {
    let mut output = tokio::fs::File::create(path)
        .await
        .wrap_err_with(|| format!("failed to create evaluator event log {}", path.display()))?;
    let mut atif = AtifBuilder::default();
    let mut atif_error = None;
    while let Some(event) = stream.recv().await? {
        if let EvalEventKind::Agent(agent_event) = &event.kind
            && atif_error.is_none()
            && let Err(error) = atif.apply(agent_event)
        {
            atif_error = Some(format!(
                "failed to project agent event sequence {} into ATIF: {error}",
                event.sequence
            ));
        }
        let mut encoded = serde_json::to_vec(event.as_ref())?;
        encoded.push(b'\n');
        output.write_all(&encoded).await?;
    }
    output.flush().await?;
    output.sync_all().await?;
    Ok(NativeEventRecording { atif, atif_error })
}

async fn retain_native_trajectory(
    outcome: &EvalAttemptOutcome,
    recording: NativeEventRecording,
) -> Result<()> {
    if let Some(error) = recording.atif_error {
        return Err(eyre!(error));
    }
    let trajectory = match outcome.agent() {
        Some(agent) => recording.atif.finish(outcome.task(), agent),
        None => recording.atif.finish_failure(outcome.task()),
    };
    let path = outcome.artifacts().directory.join("agent/trajectory.json");
    let parent = path
        .parent()
        .ok_or_else(|| eyre!("trajectory path has no parent: {}", path.display()))?;
    tokio::fs::create_dir_all(parent).await?;
    let mut encoded = serde_json::to_vec_pretty(&trajectory)?;
    encoded.push(b'\n');
    let mut output = tokio::fs::File::create(&path)
        .await
        .wrap_err_with(|| format!("failed to create trajectory {}", path.display()))?;
    output.write_all(&encoded).await?;
    output.flush().await?;
    output.sync_all().await?;
    Ok(())
}

pub(super) fn default_state_dir() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("NANOCODEX_HOME") {
        return Ok(PathBuf::from(home).join("evals"));
    }
    let home = std::env::var_os("HOME")
        .ok_or_else(|| eyre!("HOME is not set; pass --state-dir for durable eval state"))?;
    Ok(PathBuf::from(home).join(".nanocodex/evals"))
}

fn print_remote_status(status: &serde_json::Value) {
    let profile = status["profile"].as_str().unwrap_or("unknown");
    let digest = status["digest"].as_str().unwrap_or("unknown");
    let tasks = &status["tasks"];
    println!(
        "{} {} · tasks {}/{} finished · {} running · {} failed",
        profile,
        &digest[..digest.len().min(12)],
        tasks["success"].as_u64().unwrap_or(0) + tasks["failed"].as_u64().unwrap_or(0),
        count_total(tasks),
        tasks["running"].as_u64().unwrap_or(0),
        tasks["failed"].as_u64().unwrap_or(0),
    );
    for family in status["families"].as_array().into_iter().flatten() {
        println!(
            "  {} · {} success · {} failed · {} running · {} unclaimed",
            family["task"].as_str().unwrap_or("unknown"),
            family["success"].as_u64().unwrap_or(0),
            family["failed"].as_u64().unwrap_or(0),
            family["running"].as_u64().unwrap_or(0),
            family["unclaimed"].as_u64().unwrap_or(0),
        );
    }
}

fn count_total(counts: &serde_json::Value) -> u64 {
    ["unclaimed", "running", "success", "failed"]
        .into_iter()
        .map(|key| counts[key].as_u64().unwrap_or(0))
        .sum()
}

fn write_json(value: &impl Serialize) -> Result<()> {
    serde_json::to_writer(std::io::stdout().lock(), value)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use clap::Parser as _;

    use nanocodex_eval::{EvalOutcome, EvalStatus};

    use super::{ExecutionDisposition, default_state_dir, execution_disposition};
    use crate::{Cli, Command, eval::EvalCommand};

    #[test]
    fn run_can_restrict_the_atomic_claim_to_one_profile_task() {
        let cli = Cli::try_parse_from([
            "nanocodex",
            "eval",
            "run",
            "release",
            "--task",
            "terminal/fix-git",
            "--worker",
            "dev-one",
            "--api-key",
            "test-key",
        ])
        .unwrap();
        let Some(Command::Eval(eval)) = cli.command else {
            panic!("expected eval command");
        };
        let EvalCommand::Run(run) = eval.command else {
            panic!("expected profile run");
        };
        assert_eq!(run.task.as_deref(), Some("terminal/fix-git"));
        assert_eq!(run.worker.as_deref(), Some("dev-one"));
    }

    #[test]
    fn run_claims_the_next_row_when_task_is_omitted() {
        let cli = Cli::try_parse_from([
            "nanocodex",
            "eval",
            "run",
            "release",
            "--worker",
            "dev-one",
            "--api-key",
            "test-key",
        ])
        .unwrap();
        let Some(Command::Eval(eval)) = cli.command else {
            panic!("expected eval command");
        };
        let EvalCommand::Run(run) = eval.command else {
            panic!("expected profile run");
        };
        assert!(run.task.is_none());
    }

    #[test]
    fn run_accepts_one_optional_external_harness() {
        let cli = Cli::try_parse_from([
            "nanocodex",
            "eval",
            "run",
            "release",
            "--task",
            "terminal/fix-git",
            "--harness",
            "codex",
            "--api-key",
            "test-key",
        ])
        .unwrap();
        let Some(Command::Eval(eval)) = cli.command else {
            panic!("expected eval command");
        };
        let EvalCommand::Run(run) = eval.command else {
            panic!("expected profile run");
        };
        assert_eq!(run.harness.as_deref(), Some("codex"));
    }

    #[test]
    fn explicit_state_directory_is_optional() {
        let cli = Cli::try_parse_from([
            "nanocodex",
            "eval",
            "status",
            "release",
            "--state-dir",
            "/mnt/evals",
        ])
        .unwrap();
        let Some(Command::Eval(eval)) = cli.command else {
            panic!("expected eval command");
        };
        let EvalCommand::Status(status) = eval.command else {
            panic!("expected profile status");
        };
        assert_eq!(
            status.target.state_dir.as_deref(),
            Some(Path::new("/mnt/evals"))
        );
    }

    #[test]
    fn nanocodex_home_owns_the_default_eval_directory() {
        let path = default_state_dir().unwrap();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("evals")
        );
    }

    #[test]
    fn lifecycle_failures_cannot_become_scored_successes() {
        assert_eq!(
            execution_disposition(EvalOutcome::InfrastructureError),
            ExecutionDisposition::Retry
        );
        assert_eq!(
            execution_disposition(EvalOutcome::AgentTimeout),
            ExecutionDisposition::Retry
        );
        assert_eq!(
            execution_disposition(EvalOutcome::SafetyRefusal),
            ExecutionDisposition::Completed(EvalStatus::Failed)
        );
        assert_eq!(
            execution_disposition(EvalOutcome::Passed),
            ExecutionDisposition::Completed(EvalStatus::Passed)
        );
        assert_eq!(
            execution_disposition(EvalOutcome::VerifierFailed),
            ExecutionDisposition::Completed(EvalStatus::Failed)
        );
    }
}
