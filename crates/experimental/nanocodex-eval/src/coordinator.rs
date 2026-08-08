//! Narrow pull coordinator for durable evaluation workers.

use std::{
    collections::HashMap,
    io::Write,
    net::{IpAddr, SocketAddr},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, Path as AxumPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use futures_util::StreamExt as _;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt as _, net::TcpListener, sync::Mutex, task::JoinHandle};
use tokio_util::io::{ReaderStream, SyncIoBridge};
use uuid::Uuid;

use crate::{
    CoordinateClaim, Evaluation, EvaluationClaim, EvaluationSelector, EvaluationStatus,
    EvaluationTreatment, EvaluationWork, PreparationClaim, Task, api::EvalApi,
};

const MAX_COMPRESSED_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const ARTIFACT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_EXTRACTED_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const ARCHIVE_BUFFER_BYTES: usize = 64 * 1024;
const ARCHIVE_CONTENT_TYPE: &str = "application/x-tar+zstd";
const EVIDENCE_EXTENSIONS: [&str; 2] = ["json", "jsonl"];
const VERIFIER_EVIDENCE: [&str; 3] = ["reward.txt", "test-stdout.txt", "test-stderr.txt"];
const EXCLUDED_EVIDENCE_DIRECTORIES: [&str; 3] = ["tests", "vm", "workspace"];

/// Loopback HTTP coordinator backed by one durable evaluation ledger.
pub struct CoordinatorServer {
    state: CoordinatorState,
    worker_timeout: Duration,
}

/// HTTP client used by one pull worker.
#[derive(Clone, Debug)]
pub struct CoordinatorClient {
    base: Url,
    http: reqwest::Client,
    worker: Option<String>,
}

/// Work to append to the coordinator-owned SQLite evaluation.
///
/// Task paths are resolved on the coordinator host and must be absolute.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CoordinatorAddRequest {
    /// Expected profile owned by the target coordinator.
    pub profile: String,
    /// Optional profile recipe resolved from the coordinator's configuration.
    pub recipe: Option<String>,
    /// Absolute task-package paths visible on the coordinator host.
    #[serde(default)]
    pub tasks: Vec<String>,
    /// Harness matrix. An empty list selects built-in Nanocodex.
    #[serde(default)]
    pub harnesses: Vec<String>,
    /// Model matrix. Values use ordinary Nanocodex model names.
    #[serde(default)]
    pub models: Vec<String>,
    /// Reasoning-effort matrix.
    #[serde(default)]
    pub thinking: Vec<String>,
    /// Desired repetitions for each concrete treatment.
    pub trials: Option<u16>,
    /// Whether model-facing web search is enabled.
    #[serde(default)]
    pub web_search: bool,
    /// Whether to start a new generation instead of extending the latest one.
    #[serde(default)]
    pub new_generation: bool,
}

/// One action atomically allocated by the coordinator.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemoteClaim {
    /// This host must prepare the selected task first.
    Prepare {
        /// Opaque lease capability required for all later mutations.
        lease: RemoteLease,
        /// Exact treatment resolved by the coordinator from SQLite.
        treatment: EvaluationTreatment,
    },
    /// Execute one coordinator-allocated repetition.
    Run {
        /// Opaque lease capability required for all later mutations.
        lease: RemoteLease,
        /// Internal fungible repetition selected by SQLite.
        repetition: u16,
        /// Exact treatment resolved by the coordinator from SQLite.
        treatment: EvaluationTreatment,
    },
    /// Matching work is temporarily unavailable.
    Busy {
        /// Stable retry classification.
        reason: String,
        /// Coordinator-suggested delay.
        retry_after_ms: u64,
    },
    /// Every desired repetition in this family is terminal.
    Complete,
}

/// Opaque capability for one preparation or coordinate claim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteLease {
    token: String,
}

/// Coordinator transport or lifecycle failure.
#[derive(Debug, thiserror::Error)]
pub enum CoordinatorError {
    /// Coordinator URL is invalid or unsafe for the initial transport.
    #[error("invalid evaluation coordinator URL: {0}")]
    InvalidUrl(String),
    /// HTTP request failed.
    #[error("evaluation coordinator request failed: {0}")]
    Http(#[from] reqwest::Error),
    /// Local artifact I/O failed.
    #[error("evaluation coordinator artifact I/O failed: {0}")]
    Io(#[from] std::io::Error),
    /// Coordinator rejected a request.
    #[error("evaluation coordinator rejected the request ({status}): {message}")]
    Rejected {
        /// HTTP status returned by the coordinator.
        status: StatusCode,
        /// Bounded coordinator diagnostic.
        message: String,
    },
    /// A worker attempted to upload evidence outside its output directory.
    #[error("accepted evidence is outside the worker output directory")]
    EvidencePath,
    /// Blocking archive construction or extraction failed.
    #[error("evaluation artifact archive task failed: {0}")]
    ArchiveTask(#[from] tokio::task::JoinError),
    /// Coordinator returned an invalid retained treatment.
    #[error("evaluation coordinator returned an invalid treatment: {0}")]
    InvalidTreatment(String),
}

#[derive(Clone)]
struct CoordinatorState {
    evaluation: Evaluation,
    eval_api: EvalApi,
    lease_duration: Duration,
    active: Arc<Mutex<HashMap<String, ActiveClaim>>>,
}

struct ActiveClaim {
    claim: HeldClaim,
    last_seen: Instant,
}

enum HeldClaim {
    Preparation(PreparationClaim),
    Coordinate(CoordinateClaim),
}

#[derive(Deserialize)]
struct ClaimRequest {
    task: String,
    harness: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    web_search: Option<bool>,
    worker: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct WireTreatment {
    harness: String,
    model: String,
    thinking: String,
    web_search: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum ClaimResponse {
    Prepare {
        lease: String,
        treatment: WireTreatment,
    },
    Run {
        lease: String,
        repetition: u16,
        treatment: WireTreatment,
    },
    Busy {
        reason: String,
        retry_after_ms: u64,
    },
    Complete,
}

#[derive(Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum FinishRequest {
    Prepared,
    Accepted { evidence: String },
    Retry { error: String },
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
}

#[derive(Deserialize)]
struct EvalOutcomesQuery {
    cursor: Option<usize>,
    limit: Option<usize>,
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl CoordinatorServer {
    /// Creates a coordinator with conservative five-minute SQLite leases.
    #[must_use]
    pub fn new(evaluation: Evaluation) -> Self {
        Self::with_policy(
            evaluation,
            Duration::from_secs(5 * 60),
            Duration::from_secs(90),
        )
    }

    /// Creates a coordinator with explicit lease and worker-liveness policy.
    #[must_use]
    fn with_policy(
        evaluation: Evaluation,
        lease_duration: Duration,
        worker_timeout: Duration,
    ) -> Self {
        let eval_api = EvalApi::new(evaluation.state_directory());
        Self {
            state: CoordinatorState {
                evaluation,
                eval_api,
                lease_duration,
                active: Arc::new(Mutex::new(HashMap::new())),
            },
            worker_timeout,
        }
    }

    /// Serves the coordinator on a loopback listener until shutdown.
    pub async fn serve(self, listener: TcpListener) -> Result<(), CoordinatorError> {
        let bind = listener.local_addr()?.ip();
        if !bind.is_loopback() {
            return Err(CoordinatorError::InvalidUrl(
                "coordinators may bind only to loopback".to_owned(),
            ));
        }
        let reaper = spawn_reaper(self.state.active.clone(), self.worker_timeout);
        let app = Router::new()
            .route("/v1/health", get(health))
            .route("/v1/status", get(status))
            .route("/v1/evals", get(eval_overview))
            .route("/v1/evals/work", post(add_work))
            .route("/v1/evals/worksets/{digest}", get(eval_workset))
            .route(
                "/v1/evals/worksets/{digest}/tasks/{task_id}",
                get(eval_task),
            )
            .route(
                "/v1/evals/worksets/{digest}/tasks/{task_id}/outcomes",
                get(eval_task_outcomes),
            )
            .route("/v1/evals/cases/{id}", get(eval_case))
            .route("/v1/claims", post(claim))
            .route("/v1/claims/{token}/heartbeat", post(heartbeat))
            .route("/v1/claims/{token}/artifacts", put(upload_artifacts))
            .route("/v1/claims/{token}/finish", post(finish))
            .with_state(self.state);
        let result = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
        reaper.abort();
        result.map_err(CoordinatorError::Io)
    }
}

impl CoordinatorClient {
    /// Connects to a coordinator. Plain HTTP is accepted only on loopback.
    pub fn new(base: &str) -> Result<Self, CoordinatorError> {
        Self::with_request_timeout(base, REQUEST_TIMEOUT)
    }

    fn with_request_timeout(
        base: &str,
        request_timeout: Duration,
    ) -> Result<Self, CoordinatorError> {
        let mut base =
            Url::parse(base).map_err(|error| CoordinatorError::InvalidUrl(error.to_string()))?;
        let secure = base.scheme() == "https";
        let local_transport = base
            .host_str()
            .and_then(|host| {
                host.trim_matches(|character| character == '[' || character == ']')
                    .parse::<IpAddr>()
                    .ok()
            })
            .is_some_and(|ip| ip.is_loopback())
            || base.host_str() == Some("localhost");
        if !secure && !(base.scheme() == "http" && local_transport) {
            return Err(CoordinatorError::InvalidUrl(
                "use HTTPS, or HTTP with a loopback address".to_owned(),
            ));
        }
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        Ok(Self {
            base,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(request_timeout)
                .build()?,
            worker: None,
        })
    }

    /// Attaches an advisory worker name to future claims.
    ///
    /// Names provide stable task affinity and observability only. Lease tokens
    /// and generations remain the authority for every state transition.
    #[must_use]
    pub fn worker(mut self, name: impl Into<String>) -> Self {
        self.worker = Some(name.into());
        self
    }

    /// Reads the coordinator's complete structured ledger snapshot.
    pub async fn status(&self) -> Result<serde_json::Value, CoordinatorError> {
        let response = self.http.get(self.endpoint("v1/status")?).send().await?;
        decode(response).await
    }

    /// Checks whether the coordinator HTTP event loop can answer a request.
    pub async fn health(&self) -> Result<(), CoordinatorError> {
        accepted(self.http.get(self.endpoint("v1/health")?).send().await?).await
    }

    /// Appends work through the coordinator and returns the resulting status.
    pub async fn add(
        &self,
        request: &CoordinatorAddRequest,
    ) -> Result<serde_json::Value, CoordinatorError> {
        let response = self
            .http
            .post(self.endpoint("v1/evals/work")?)
            .json(request)
            .send()
            .await?;
        decode(response).await
    }

    /// Claims preparation or one repetition matching ordinary task selectors.
    pub async fn claim(
        &self,
        selector: &EvaluationSelector,
    ) -> Result<RemoteClaim, CoordinatorError> {
        let response: ClaimResponse = decode(
            self.http
                .post(self.endpoint("v1/claims")?)
                .json(&serde_json::json!({
                    "task": selector.task(),
                    "harness": selector.harness_name(),
                    "model": selector.model_value().map(|model| model.as_str()),
                    "thinking": selector.thinking_value().map(|thinking| thinking.as_str()),
                    "web_search": selector.web_search_value(),
                    "worker": self.worker,
                }))
                .send()
                .await?,
        )
        .await?;
        Ok(match response {
            ClaimResponse::Prepare { lease, treatment } => RemoteClaim::Prepare {
                lease: RemoteLease { token: lease },
                treatment: treatment.try_into()?,
            },
            ClaimResponse::Run {
                lease,
                repetition,
                treatment,
            } => RemoteClaim::Run {
                lease: RemoteLease { token: lease },
                repetition,
                treatment: treatment.try_into()?,
            },
            ClaimResponse::Busy {
                reason,
                retry_after_ms,
            } => RemoteClaim::Busy {
                reason,
                retry_after_ms,
            },
            ClaimResponse::Complete => RemoteClaim::Complete,
        })
    }

    /// Renews worker liveness for one opaque lease.
    pub async fn heartbeat(&self, lease: &RemoteLease) -> Result<(), CoordinatorError> {
        accepted(
            self.http
                .post(self.endpoint(&format!("v1/claims/{}/heartbeat", lease.token))?)
                .send()
                .await?,
        )
        .await
    }

    /// Marks host-local task preparation complete.
    pub async fn prepared(&self, lease: &RemoteLease) -> Result<(), CoordinatorError> {
        self.finish(lease, serde_json::json!({ "outcome": "prepared" }))
            .await
    }

    /// Releases a failed preparation or execution for retry.
    pub async fn retry(&self, lease: &RemoteLease, error: &str) -> Result<(), CoordinatorError> {
        self.finish(
            lease,
            serde_json::json!({ "outcome": "retry", "error": error }),
        )
        .await
    }

    /// Uploads canonical attempt evidence and atomically accepts its result.
    pub async fn complete(
        &self,
        lease: &RemoteLease,
        output_directory: &Path,
        evidence: &Path,
    ) -> Result<(), CoordinatorError> {
        let evidence = evidence
            .strip_prefix(output_directory)
            .map_err(|_| CoordinatorError::EvidencePath)?;
        self.upload(lease, output_directory).await?;
        self.finish(
            lease,
            serde_json::json!({
                "outcome": "accepted",
                "evidence": evidence.to_string_lossy(),
            }),
        )
        .await
    }

    /// Uploads retained canonical evidence without accepting a terminal result.
    pub async fn upload(
        &self,
        lease: &RemoteLease,
        output_directory: &Path,
    ) -> Result<(), CoordinatorError> {
        let (writer, reader) = tokio::io::duplex(ARCHIVE_BUFFER_BYTES);
        let directory = output_directory.to_path_buf();
        let archive = tokio::task::spawn_blocking(move || {
            write_evidence_archive(&directory, SyncIoBridge::new(writer))
        });
        let response = self
            .http
            .put(self.endpoint(&format!("v1/claims/{}/artifacts", lease.token))?)
            .header(reqwest::header::CONTENT_TYPE, ARCHIVE_CONTENT_TYPE)
            .body(reqwest::Body::wrap_stream(ReaderStream::new(reader)))
            .timeout(ARTIFACT_TIMEOUT)
            .send()
            .await;
        archive.await??;
        accepted(response?).await
    }

    fn endpoint(&self, path: &str) -> Result<Url, CoordinatorError> {
        self.base
            .join(path)
            .map_err(|error| CoordinatorError::InvalidUrl(error.to_string()))
    }

    async fn finish(
        &self,
        lease: &RemoteLease,
        body: serde_json::Value,
    ) -> Result<(), CoordinatorError> {
        accepted(
            self.http
                .post(self.endpoint(&format!("v1/claims/{}/finish", lease.token))?)
                .json(&body)
                .send()
                .await?,
        )
        .await
    }
}

async fn health() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn status(
    State(state): State<CoordinatorState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let evaluation = state.evaluation;
    let status = tokio::task::spawn_blocking(move || evaluation.status())
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::ledger)?;
    Ok(Json(
        serde_json::to_value(status).map_err(ApiError::internal)?,
    ))
}

async fn add_work(
    State(state): State<CoordinatorState>,
    Json(request): Json<CoordinatorAddRequest>,
) -> Result<Json<EvaluationStatus>, ApiError> {
    let evaluation = state.evaluation;
    let status = tokio::task::spawn_blocking(move || apply_add(&evaluation, request))
        .await
        .map_err(ApiError::internal)??;
    Ok(Json(status))
}

fn apply_add(
    evaluation: &Evaluation,
    request: CoordinatorAddRequest,
) -> Result<EvaluationStatus, ApiError> {
    let CoordinatorAddRequest {
        profile,
        recipe,
        tasks,
        harnesses,
        models,
        thinking,
        trials,
        web_search,
        new_generation,
    } = request;
    if profile != evaluation.name() {
        return Err(ApiError::bad_request(format!(
            "coordinator owns profile {:?}, not {:?}",
            evaluation.name(),
            profile
        )));
    }
    if let Some(recipe) = recipe {
        if !tasks.is_empty()
            || !harnesses.is_empty()
            || !models.is_empty()
            || !thinking.is_empty()
            || trials.is_some()
            || web_search
        {
            return Err(ApiError::bad_request(
                "recipe work cannot be combined with explicit work knobs",
            ));
        }
        Evaluation::add_profile(
            evaluation.config(),
            Some(&recipe),
            evaluation.state_directory(),
            evaluation.name(),
            new_generation,
        )
        .map_err(ApiError::ledger)?;
        return evaluation.status().map_err(ApiError::ledger);
    }
    if tasks.is_empty() {
        return Err(ApiError::bad_request(
            "at least one task or recipe is required",
        ));
    }
    let trials = trials.unwrap_or(1);
    if trials == 0 {
        return Err(ApiError::bad_request(
            "evaluation treatments must request at least one trial",
        ));
    }
    if harnesses.iter().any(|harness| harness.trim().is_empty()) {
        return Err(ApiError::bad_request("harness names cannot be empty"));
    }
    let models = if models.is_empty() {
        vec![nanocodex_oai_api::Model::default()]
    } else {
        models
            .into_iter()
            .map(|model| model.parse().map_err(ApiError::bad_request))
            .collect::<Result<Vec<_>, _>>()?
    };
    let thinking = if thinking.is_empty() {
        vec![nanocodex_oai_api::Thinking::default()]
    } else {
        thinking
            .into_iter()
            .map(|thinking| thinking.parse().map_err(ApiError::bad_request))
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut work = Vec::new();
    for selector in tasks {
        let path = PathBuf::from(&selector);
        if !path.is_absolute() {
            return Err(ApiError::bad_request(format!(
                "remote task paths must be absolute: {selector}"
            )));
        }
        let task = Task::load(&path).map_err(ApiError::bad_request)?;
        let selected_harnesses = harnesses
            .iter()
            .map(Some)
            .chain(harnesses.is_empty().then_some(None));
        for harness in selected_harnesses {
            for model in &models {
                for thinking in &thinking {
                    let mut item = EvaluationWork::new(&selector, task.clone())
                        .model(*model)
                        .thinking(*thinking)
                        .web_search(web_search)
                        .trials(trials);
                    if let Some(harness) = harness {
                        item = item.harness(harness);
                    }
                    work.push(item);
                }
            }
        }
    }
    Evaluation::add(
        evaluation.state_directory(),
        evaluation.name(),
        &work,
        new_generation,
    )
    .map_err(ApiError::ledger)?;
    evaluation.status().map_err(ApiError::ledger)
}

async fn eval_overview(State(state): State<CoordinatorState>) -> Result<Response, ApiError> {
    let api = state.eval_api;
    let overview = tokio::task::spawn_blocking(move || api.overview())
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    Ok(Json(overview).into_response())
}

async fn eval_workset(
    State(state): State<CoordinatorState>,
    AxumPath(digest): AxumPath<String>,
) -> Result<Response, ApiError> {
    let api = state.eval_api;
    let workset = tokio::task::spawn_blocking(move || api.workset(&digest))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    workset
        .map(|workset| Json(workset).into_response())
        .ok_or_else(|| ApiError::not_found("evaluation workset was not found"))
}

async fn eval_task(
    State(state): State<CoordinatorState>,
    AxumPath((digest, task_id)): AxumPath<(String, String)>,
) -> Result<Response, ApiError> {
    let api = state.eval_api;
    let task = tokio::task::spawn_blocking(move || api.task(&digest, &task_id))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    task.map(|task| Json(task).into_response())
        .ok_or_else(|| ApiError::not_found("evaluation task was not found"))
}

async fn eval_task_outcomes(
    State(state): State<CoordinatorState>,
    AxumPath((digest, task_id)): AxumPath<(String, String)>,
    Query(query): Query<EvalOutcomesQuery>,
) -> Result<Response, ApiError> {
    let cursor = query.cursor.unwrap_or(0);
    let limit = query.limit.unwrap_or(8);
    if !(1..=32).contains(&limit) {
        return Err(ApiError::bad_request(
            "evaluation outcome page limit must be between 1 and 32",
        ));
    }
    let api = state.eval_api;
    let page =
        tokio::task::spawn_blocking(move || api.task_outcomes(&digest, &task_id, cursor, limit))
            .await
            .map_err(ApiError::internal)?
            .map_err(ApiError::internal)?;
    page.map(|page| Json(page).into_response())
        .ok_or_else(|| ApiError::not_found("evaluation task was not found"))
}

async fn eval_case(
    State(state): State<CoordinatorState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let api = state.eval_api;
    let evidence = tokio::task::spawn_blocking(move || api.case(&id))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    evidence
        .map(|evidence| Json(evidence).into_response())
        .ok_or_else(|| ApiError::not_found("evaluation case was not found"))
}

async fn claim(
    State(state): State<CoordinatorState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<ClaimRequest>,
) -> Result<Json<ClaimResponse>, ApiError> {
    let host = request
        .worker
        .filter(|worker| !worker.trim().is_empty())
        .unwrap_or_else(|| peer.ip().to_string());
    let model = request
        .model
        .map(|model| model.parse().map_err(ApiError::bad_request))
        .transpose()?;
    let thinking = request
        .thinking
        .map(|thinking| thinking.parse().map_err(ApiError::bad_request))
        .transpose()?;
    let selector = EvaluationSelector::new(request.task)
        .harness(request.harness)
        .model(model)
        .thinking(thinking)
        .web_search(request.web_search);
    let evaluation = state.evaluation.clone();
    let lease_duration = state.lease_duration;
    let claim = tokio::task::spawn_blocking(move || {
        evaluation.claim_for_host(&selector, &host, lease_duration)
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(ApiError::bad_gateway)?;
    let response = match claim {
        EvaluationClaim::Prepare(claim) => {
            let treatment = claim.treatment().into();
            let lease = insert_claim(&state, HeldClaim::Preparation(claim)).await;
            ClaimResponse::Prepare { lease, treatment }
        }
        EvaluationClaim::Run(claim) => {
            let repetition = claim.repetition();
            let treatment = claim.treatment().into();
            let lease = insert_claim(&state, HeldClaim::Coordinate(claim)).await;
            ClaimResponse::Run {
                lease,
                repetition,
                treatment,
            }
        }
        EvaluationClaim::Busy(busy) => ClaimResponse::Busy {
            reason: busy.reason.to_owned(),
            retry_after_ms: busy.retry_after_ms,
        },
        EvaluationClaim::Complete => ClaimResponse::Complete,
    };
    Ok(Json(response))
}

async fn heartbeat(
    State(state): State<CoordinatorState>,
    AxumPath(token): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let mut active = state.active.lock().await;
    let claim = active
        .get_mut(&token)
        .ok_or_else(|| ApiError::not_found("claim is absent or expired"))?;
    claim.last_seen = Instant::now();
    Ok(StatusCode::NO_CONTENT)
}

async fn upload_artifacts(
    State(state): State<CoordinatorState>,
    AxumPath(token): AxumPath<String>,
    body: Body,
) -> Result<StatusCode, ApiError> {
    let output = {
        let active = state.active.lock().await;
        let claim = active
            .get(&token)
            .ok_or_else(|| ApiError::not_found("claim is absent or expired"))?;
        match &claim.claim {
            HeldClaim::Coordinate(claim) => claim.output_directory().to_path_buf(),
            HeldClaim::Preparation(_) => {
                return Err(ApiError::bad_request(
                    "preparation claims cannot upload execution artifacts",
                ));
            }
        }
    };
    receive_archive(body, &output, &token).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn finish(
    State(state): State<CoordinatorState>,
    AxumPath(token): AxumPath<String>,
    Json(request): Json<FinishRequest>,
) -> Result<StatusCode, ApiError> {
    let active = state
        .active
        .lock()
        .await
        .remove(&token)
        .ok_or_else(|| ApiError::not_found("claim is absent or expired"))?;
    tokio::task::spawn_blocking(move || finish_claim(active.claim, request))
        .await
        .map_err(ApiError::internal)??;
    Ok(StatusCode::NO_CONTENT)
}

fn finish_claim(claim: HeldClaim, request: FinishRequest) -> Result<(), ApiError> {
    match (claim, request) {
        (HeldClaim::Preparation(claim), FinishRequest::Prepared) => {
            claim.complete().map_err(ApiError::ledger)?;
        }
        (HeldClaim::Preparation(claim), FinishRequest::Retry { error }) => {
            claim.retry(&error).map_err(ApiError::ledger)?;
        }
        (HeldClaim::Coordinate(claim), FinishRequest::Accepted { evidence }) => {
            let evidence = safe_evidence(claim.output_directory(), &evidence)?;
            if !evidence.exists() {
                return Err(ApiError::bad_request("accepted evidence was not uploaded"));
            }
            claim.complete(&evidence).map_err(ApiError::ledger)?;
        }
        (HeldClaim::Coordinate(claim), FinishRequest::Retry { error }) => {
            claim.retry(&error).map_err(ApiError::ledger)?;
        }
        _ => {
            return Err(ApiError::bad_request(
                "finish outcome does not match claim kind",
            ));
        }
    }
    Ok(())
}

async fn insert_claim(state: &CoordinatorState, claim: HeldClaim) -> String {
    let token = Uuid::now_v7().simple().to_string();
    state.active.lock().await.insert(
        token.clone(),
        ActiveClaim {
            claim,
            last_seen: Instant::now(),
        },
    );
    token
}

fn spawn_reaper(
    active: Arc<Mutex<HashMap<String, ActiveClaim>>>,
    worker_timeout: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let interval = (worker_timeout / 3).max(Duration::from_millis(10));
        let mut ticker = tokio::time::interval(interval);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let expired = {
                let mut active = active.lock().await;
                let tokens = active
                    .iter()
                    .filter(|(_, claim)| claim.last_seen.elapsed() > worker_timeout)
                    .map(|(token, _)| token.clone())
                    .collect::<Vec<_>>();
                tokens
                    .into_iter()
                    .filter_map(|token| active.remove(&token))
                    .collect::<Vec<_>>()
            };
            let release = tokio::task::spawn_blocking(move || {
                expired
                    .into_iter()
                    .filter_map(|expired| {
                        let result = match expired.claim {
                            HeldClaim::Preparation(claim) => {
                                claim.retry("coordinator worker heartbeat expired")
                            }
                            HeldClaim::Coordinate(claim) => {
                                claim.retry("coordinator worker heartbeat expired")
                            }
                        };
                        result.err()
                    })
                    .collect::<Vec<_>>()
            })
            .await;
            match release {
                Ok(errors) => {
                    for error in errors {
                        tracing::warn!(%error, "failed to release expired coordinator claim");
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "coordinator claim reaper task failed");
                }
            }
        }
    })
}

async fn receive_archive(body: Body, output: &Path, token: &str) -> Result<(), ApiError> {
    let parent = output
        .parent()
        .ok_or_else(|| ApiError::internal("claim output has no parent"))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(ApiError::internal)?;
    remove_stale_uploads(parent).await?;
    let upload = parent.join(format!(".{token}.tar.zst"));
    let staging = parent.join(format!(".{token}.staging"));
    let mut file = tokio::fs::File::create(&upload)
        .await
        .map_err(ApiError::internal)?;
    let mut stream = body.into_data_stream();
    let mut received = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(ApiError::internal)?;
        received = received
            .checked_add(u64::try_from(chunk.len()).map_err(ApiError::internal)?)
            .ok_or_else(|| ApiError::bad_request("artifact upload is too large"))?;
        if received > MAX_COMPRESSED_ARTIFACT_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&upload).await;
            return Err(ApiError::bad_request("artifact upload is too large"));
        }
        file.write_all(&chunk).await.map_err(ApiError::internal)?;
    }
    file.sync_all().await.map_err(ApiError::internal)?;
    drop(file);
    let upload_for_task = upload.clone();
    let output = output.to_path_buf();
    let staging_for_task = staging.clone();
    let extraction = tokio::task::spawn_blocking(move || {
        extract_evidence_archive(&upload_for_task, &staging_for_task, &output)
    })
    .await
    .map_err(ApiError::internal)?;
    let _ = tokio::fs::remove_file(&upload).await;
    if let Err(error) = extraction {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(ApiError::bad_request(error));
    }
    Ok(())
}

async fn remove_stale_uploads(parent: &Path) -> Result<(), ApiError> {
    let mut entries = tokio::fs::read_dir(parent)
        .await
        .map_err(ApiError::internal)?;
    while let Some(entry) = entries.next_entry().await.map_err(ApiError::internal)? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if name.ends_with(".tar") || name.ends_with(".tar.zst") {
            tokio::fs::remove_file(path)
                .await
                .map_err(ApiError::internal)?;
        } else if name.ends_with(".staging") {
            tokio::fs::remove_dir_all(path)
                .await
                .map_err(ApiError::internal)?;
        }
    }
    Ok(())
}

fn extract_evidence_archive(archive: &Path, staging: &Path, output: &Path) -> std::io::Result<()> {
    if output.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "artifact output already exists",
        ));
    }
    std::fs::create_dir(staging)?;
    let file = std::fs::File::open(archive)?;
    let decoder = zstd::Decoder::new(file)?;
    let mut archive = tar::Archive::new(decoder);
    let mut extracted = 0_u64;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        if !entry.header().entry_type().is_file() || !is_evidence_path(&path) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "artifact archive contained unsupported evidence: {}",
                    path.display()
                ),
            ));
        }
        extracted = extracted
            .checked_add(entry.size())
            .ok_or_else(|| std::io::Error::other("extracted evidence is too large"))?;
        if extracted > MAX_EXTRACTED_ARTIFACT_BYTES {
            return Err(std::io::Error::other("extracted evidence is too large"));
        }
        if !entry.unpack_in(staging)? {
            return Err(std::io::Error::other(
                "artifact archive escaped its output directory",
            ));
        }
    }
    std::fs::rename(staging, output)?;
    Ok(())
}

fn write_evidence_archive<W: Write>(directory: &Path, writer: W) -> std::io::Result<()> {
    let encoder = zstd::Encoder::new(writer, 3)?;
    let mut archive = tar::Builder::new(encoder);
    append_evidence(&mut archive, directory, directory)?;
    let encoder = archive.into_inner()?;
    encoder.finish()?.flush()
}

fn append_evidence<W: Write>(
    archive: &mut tar::Builder<W>,
    root: &Path,
    directory: &Path,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| std::io::Error::other("evidence path escaped its output directory"))?;
        if file_type.is_dir() {
            if !is_excluded_evidence_directory(relative) {
                append_evidence(archive, root, &path)?;
            }
        } else if file_type.is_file() && is_evidence_path(relative) {
            archive.append_path_with_name(&path, relative)?;
        }
    }
    Ok(())
}

fn is_evidence_path(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && !is_excluded_evidence_directory(path)
        && (path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| EVIDENCE_EXTENSIONS.contains(&extension))
            || path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| VERIFIER_EVIDENCE.contains(&name)))
}

fn is_excluded_evidence_directory(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        name.to_str()
            .is_some_and(|name| EXCLUDED_EVIDENCE_DIRECTORIES.contains(&name))
    })
}

fn safe_evidence(output: &Path, relative: &str) -> Result<PathBuf, ApiError> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(ApiError::bad_request(
            "evidence path escaped its uploaded attempt",
        ));
    }
    Ok(output.join(relative))
}

async fn accepted(response: reqwest::Response) -> Result<(), CoordinatorError> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(rejected(response).await)
    }
}

async fn decode<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, CoordinatorError> {
    if response.status().is_success() {
        Ok(response.json().await?)
    } else {
        Err(rejected(response).await)
    }
}

async fn rejected(response: reqwest::Response) -> CoordinatorError {
    let status = response.status();
    let message = response
        .text()
        .await
        .unwrap_or_else(|_| "coordinator response body was unreadable".to_owned());
    CoordinatorError::Rejected {
        status,
        message: message.chars().take(4_096).collect(),
    }
}

impl ApiError {
    fn bad_request(message: impl ToString) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.to_string(),
        }
    }

    fn not_found(message: impl ToString) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.to_string(),
        }
    }

    fn bad_gateway(message: impl ToString) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.to_string(),
        }
    }

    fn ledger(error: crate::EvaluationError) -> Self {
        Self::bad_gateway(error)
    }

    fn internal(message: impl ToString) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.to_string(),
        }
    }
}

impl From<&EvaluationTreatment> for WireTreatment {
    fn from(treatment: &EvaluationTreatment) -> Self {
        Self {
            harness: treatment.harness.clone(),
            model: treatment.model.as_str().to_owned(),
            thinking: treatment.thinking.as_str().to_owned(),
            web_search: treatment.web_search,
        }
    }
}

impl TryFrom<WireTreatment> for EvaluationTreatment {
    type Error = CoordinatorError;

    fn try_from(treatment: WireTreatment) -> Result<Self, Self::Error> {
        let model = treatment
            .model
            .parse()
            .map_err(|error| CoordinatorError::InvalidTreatment(format!("model: {error}")))?;
        let thinking = treatment
            .thinking
            .parse()
            .map_err(|error| CoordinatorError::InvalidTreatment(format!("thinking: {error}")))?;
        Ok(Self {
            harness: treatment.harness,
            model,
            thinking,
            web_search: treatment.web_search,
        })
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(ErrorBody {
            error: &self.message,
        });
        (self.status, body).into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use nanocodex_oai_api::{Model, Thinking};
    use rusqlite::Connection;

    use super::*;
    use crate::{EvaluationSelector, EvaluationWork, Task, coordinator::RemoteClaim};

    fn write_task(root: &Path, name: &str) {
        let task = root.join(name);
        fs::create_dir_all(task.join("environment")).unwrap();
        fs::create_dir_all(task.join("tests")).unwrap();
        fs::write(
            task.join("task.toml"),
            format!(
                r#"schema_version = "1.1"
[task]
name = "{name}"
description = "test"
[agent]
timeout_sec = 1.0
[verifier]
timeout_sec = 1.0
[environment]
docker_image = "alpine:3.21"
cpus = 1
memory_mb = 128
storage_mb = 128
gpus = 0
allow_internet = false
"#,
                name = name
            ),
        )
        .unwrap();
        fs::write(task.join("instruction.md"), "do it").unwrap();
        fs::write(task.join("environment/Dockerfile"), "FROM scratch").unwrap();
        fs::write(task.join("tests/test.sh"), "#!/bin/sh\n").unwrap();
    }

    async fn fixture() -> (
        tempfile::TempDir,
        CoordinatorClient,
        EvaluationSelector,
        JoinHandle<()>,
    ) {
        fixture_with_policy(Duration::from_secs(30), Duration::from_secs(5), 2).await
    }

    async fn fixture_with_policy(
        lease_duration: Duration,
        worker_timeout: Duration,
        trials: u16,
    ) -> (
        tempfile::TempDir,
        CoordinatorClient,
        EvaluationSelector,
        JoinHandle<()>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        write_task(directory.path(), "one");
        let state = directory.path().join("state");
        let task = Task::load(directory.path().join("one")).unwrap();
        let work = EvaluationWork::new("one", task)
            .model(Model::Sol)
            .thinking(Thinking::High)
            .trials(trials);
        Evaluation::add(&state, "release", &[work], false).unwrap();
        let missing_profile = directory.path().join("profile-is-not-required.toml");
        let evaluation = Evaluation::open(missing_profile, "release", state).unwrap();
        let selection = EvaluationSelector::new("one");
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            CoordinatorServer::with_policy(evaluation, lease_duration, worker_timeout)
                .serve(listener)
                .await
                .unwrap();
        });
        let client = CoordinatorClient::new(&format!("http://{address}")).unwrap();
        (directory, client, selection, server)
    }

    #[tokio::test]
    async fn coordinator_client_times_out_when_the_server_stops_answering() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let stalled = tokio::spawn(async move {
            let (_connection, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let client = CoordinatorClient::with_request_timeout(
            &format!("http://{address}"),
            Duration::from_millis(50),
        )
        .unwrap();

        let error = client.health().await.unwrap_err();
        assert!(matches!(error, CoordinatorError::Http(error) if error.is_timeout()));
        stalled.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn locked_ledger_does_not_block_the_coordinator_health_route() {
        let (directory, client, selection, server) = fixture().await;
        let connection = Connection::open(directory.path().join("state/state.sqlite3")).unwrap();
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        let claim_client = client.clone();
        let claim = tokio::spawn(async move { claim_client.claim(&selection).await });
        tokio::time::sleep(Duration::from_millis(50)).await;

        tokio::time::timeout(Duration::from_millis(500), client.health())
            .await
            .expect("health route must remain scheduled while SQLite is busy")
            .unwrap();

        connection.execute_batch("ROLLBACK").unwrap();
        let RemoteClaim::Prepare { lease, .. } =
            tokio::time::timeout(Duration::from_secs(2), claim)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
        else {
            panic!("the pending preparation should be claimed after SQLite unlocks");
        };
        client.retry(&lease, "test cleanup").await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn running_coordinator_reads_appends_and_new_generations_from_sqlite() {
        let (directory, client, _selection, server) = fixture().await;
        let state = directory.path().join("state");
        write_task(directory.path(), "two");
        let two = Task::load(directory.path().join("two")).unwrap();
        Evaluation::add(
            &state,
            "release",
            &[EvaluationWork::new("two", two)
                .model(Model::Sol)
                .thinking(Thinking::High)],
            false,
        )
        .unwrap();

        let appended = client.status().await.unwrap();
        assert_eq!(appended["coordinates"]["pending"], 3);
        assert_eq!(appended["families"].as_array().unwrap().len(), 2);
        let two = EvaluationSelector::new("two");
        let RemoteClaim::Prepare { lease, .. } = client.claim(&two).await.unwrap() else {
            panic!("the running coordinator must claim newly appended work");
        };
        client.prepared(&lease).await.unwrap();
        let RemoteClaim::Run { lease, .. } = client.claim(&two).await.unwrap() else {
            panic!("the appended task must become runnable");
        };
        client.retry(&lease, "test cleanup").await.unwrap();

        let previous_generation = appended["generation"].as_str().unwrap().to_owned();
        let one = Task::load(directory.path().join("one")).unwrap();
        Evaluation::add(
            &state,
            "release",
            &[EvaluationWork::new("one", one)
                .model(Model::Sol)
                .thinking(Thinking::High)
                .trials(3)],
            true,
        )
        .unwrap();

        let replaced = client.status().await.unwrap();
        assert_ne!(replaced["generation"], previous_generation);
        assert_eq!(replaced["coordinates"]["pending"], 3);
        assert_eq!(replaced["families"].as_array().unwrap().len(), 1);
        server.abort();
    }

    #[tokio::test]
    async fn coordinator_add_route_appends_and_replaces_work_without_restart() {
        let (directory, client, _selection, server) = fixture().await;
        write_task(directory.path(), "two");
        let two = directory.path().join("two");
        let initial = client.status().await.unwrap();
        let initial_generation = initial["generation"].as_str().unwrap().to_owned();

        let appended = client
            .add(&CoordinatorAddRequest {
                profile: "release".to_owned(),
                tasks: vec![two.to_string_lossy().into_owned()],
                models: vec!["sol".to_owned()],
                thinking: vec!["high".to_owned()],
                trials: Some(3),
                recipe: None,
                harnesses: Vec::new(),
                web_search: false,
                new_generation: false,
            })
            .await
            .unwrap();
        assert_eq!(appended["generation"], initial_generation);
        assert_eq!(appended["coordinates"]["pending"], 5);
        assert_eq!(appended["families"].as_array().unwrap().len(), 2);

        let selector = EvaluationSelector::new(two.to_string_lossy());
        let RemoteClaim::Prepare { lease, .. } = client.claim(&selector).await.unwrap() else {
            panic!("remotely appended work must be claimable immediately");
        };
        client.prepared(&lease).await.unwrap();
        let RemoteClaim::Run { lease, .. } = client.claim(&selector).await.unwrap() else {
            panic!("remotely appended work must become runnable");
        };
        client.retry(&lease, "test cleanup").await.unwrap();

        let one = directory.path().join("one");
        let replaced = client
            .add(&CoordinatorAddRequest {
                profile: "release".to_owned(),
                tasks: vec![one.to_string_lossy().into_owned()],
                models: vec!["sol".to_owned()],
                thinking: vec!["high".to_owned()],
                trials: Some(4),
                new_generation: true,
                recipe: None,
                harnesses: Vec::new(),
                web_search: false,
            })
            .await
            .unwrap();
        assert_ne!(replaced["generation"], initial_generation);
        assert_eq!(replaced["coordinates"]["pending"], 4);
        assert_eq!(replaced["families"].as_array().unwrap().len(), 1);
        server.abort();
    }

    #[tokio::test]
    async fn coordinator_add_route_rejects_ambiguous_or_invalid_work() {
        let (_directory, client, _selection, server) = fixture().await;
        for request in [
            CoordinatorAddRequest {
                profile: "release".to_owned(),
                tasks: vec!["relative/task".to_owned()],
                recipe: None,
                harnesses: Vec::new(),
                models: Vec::new(),
                thinking: Vec::new(),
                trials: None,
                web_search: false,
                new_generation: false,
            },
            CoordinatorAddRequest {
                profile: "release".to_owned(),
                recipe: Some("release".to_owned()),
                tasks: vec!["/srv/task".to_owned()],
                harnesses: Vec::new(),
                models: Vec::new(),
                thinking: Vec::new(),
                trials: None,
                web_search: false,
                new_generation: false,
            },
            CoordinatorAddRequest {
                profile: "release".to_owned(),
                tasks: vec!["/srv/task".to_owned()],
                trials: Some(0),
                recipe: None,
                harnesses: Vec::new(),
                models: Vec::new(),
                thinking: Vec::new(),
                web_search: false,
                new_generation: false,
            },
        ] {
            assert!(matches!(
                client.add(&request).await,
                Err(CoordinatorError::Rejected {
                    status: StatusCode::BAD_REQUEST,
                    ..
                })
            ));
        }
        assert!(matches!(
            client
                .add(&CoordinatorAddRequest {
                    profile: "another-profile".to_owned(),
                    recipe: None,
                    tasks: vec!["/srv/task".to_owned()],
                    harnesses: Vec::new(),
                    models: Vec::new(),
                    thinking: Vec::new(),
                    trials: None,
                    web_search: false,
                    new_generation: false,
                })
                .await,
            Err(CoordinatorError::Rejected {
                status: StatusCode::BAD_REQUEST,
                ..
            })
        ));
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn concurrent_workers_claim_every_repetition_exactly_once() {
        const TRIALS: u16 = 32;
        let (_directory, client, selection, server) =
            fixture_with_policy(Duration::from_secs(30), Duration::from_secs(5), TRIALS).await;
        let client = client.worker("saturated-host");
        let RemoteClaim::Prepare { lease, .. } = client.claim(&selection).await.unwrap() else {
            panic!("first claim should prepare the task");
        };
        client.prepared(&lease).await.unwrap();

        let claims = futures_util::future::join_all((0..TRIALS).map(|_| {
            let client = client.clone();
            let selection = selection.clone();
            async move { client.claim(&selection).await }
        }))
        .await;
        let mut repetitions = Vec::with_capacity(usize::from(TRIALS));
        let mut leases = Vec::with_capacity(usize::from(TRIALS));
        for claim in claims {
            let RemoteClaim::Run {
                lease, repetition, ..
            } = claim.unwrap()
            else {
                panic!("every available repetition should be claimed");
            };
            repetitions.push(repetition);
            leases.push(lease);
        }
        repetitions.sort_unstable();
        assert_eq!(repetitions, (1..=TRIALS).collect::<Vec<_>>());
        for lease in leases {
            client.retry(&lease, "test cleanup").await.unwrap();
        }
        server.abort();
    }

    #[tokio::test]
    async fn workers_prepare_claim_upload_and_converge_through_the_coordinator() {
        let (directory, client, selection, server) = fixture().await;
        let client = client.worker("worker-one");
        let RemoteClaim::Prepare {
            lease: preparation, ..
        } = client.claim(&selection).await.unwrap()
        else {
            panic!("first worker should prepare");
        };
        client.heartbeat(&preparation).await.unwrap();
        client.prepared(&preparation).await.unwrap();

        let (first, second) = tokio::join!(client.claim(&selection), client.claim(&selection));
        let RemoteClaim::Run {
            lease: first_lease,
            repetition: first_repetition,
            ..
        } = first.unwrap()
        else {
            panic!("first worker should run");
        };
        let RemoteClaim::Run {
            lease: second_lease,
            repetition: second_repetition,
            ..
        } = second.unwrap()
        else {
            panic!("second worker should run");
        };
        assert_ne!(first_repetition, second_repetition);

        for (lease, name) in [(&first_lease, "first"), (&second_lease, "second")] {
            let output = directory.path().join(format!("worker-{name}"));
            fs::create_dir_all(output.join("agent")).unwrap();
            fs::create_dir_all(output.join("verifier")).unwrap();
            fs::create_dir_all(output.join("workspace")).unwrap();
            fs::create_dir_all(output.join("tests")).unwrap();
            fs::create_dir_all(output.join("vm")).unwrap();
            let evidence = output.join("comparison.json");
            fs::write(&evidence, format!("{{\"worker\":\"{name}\"}}\n")).unwrap();
            fs::write(
                output.join("events.jsonl"),
                "{\"type\":\"attempt_started\",\"payload\":{\"prompt\":\"do it\"},\"attempt\":{\"task_name\":\"one\"}}\n\
                 {\"type\":\"completed\",\"payload\":{\"task_name\":\"one\",\"status\":\"passed\",\"outcome\":\"passed\",\"environment\":\"micro_vm\",\"agent\":{\"model\":\"sol\",\"effort\":\"high\",\"tool_calls\":1,\"usage\":{\"total_tokens\":10}},\"verifier\":{\"exit_code\":0,\"rewards\":{\"reward\":1}}}}\n",
            )
            .unwrap();
            fs::write(
                output.join("agent/trajectory.json"),
                format!("{{\"worker\":\"{name}\"}}\n"),
            )
            .unwrap();
            fs::write(output.join("verifier/reward.txt"), "1\n").unwrap();
            fs::write(output.join("rootfs.ext4"), vec![0_u8; 1024 * 1024]).unwrap();
            fs::write(output.join("workspace/result.json"), "{}\n").unwrap();
            fs::write(output.join("tests/fixture.json"), "{}\n").unwrap();
            fs::write(output.join("vm/config.json"), "{}\n").unwrap();
            client.complete(lease, &output, &evidence).await.unwrap();
        }

        let status = client.status().await.unwrap();
        assert_eq!(status["coordinates"]["complete"], 2);
        assert_eq!(status["coordinates"]["pending"], 0);
        assert_eq!(status["families"][0]["assigned_host"], "worker-one");
        let overview: serde_json::Value = decode(
            client
                .http
                .get(client.endpoint("v1/evals").unwrap())
                .send()
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(overview["worksets"][0]["summary"]["completed"], 2);
        assert_eq!(overview["worksets"][0]["taskCount"], 1);
        let digest = overview["worksets"][0]["id"].as_str().unwrap();
        let workset: serde_json::Value = decode(
            client
                .http
                .get(
                    client
                        .endpoint(&format!("v1/evals/worksets/{digest}"))
                        .unwrap(),
                )
                .send()
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(workset["tasks"][0]["summary"]["completed"], 2);
        let task_id = workset["tasks"][0]["id"].as_str().unwrap();
        let task: serde_json::Value = decode(
            client
                .http
                .get(
                    client
                        .endpoint(&format!("v1/evals/worksets/{digest}/tasks/{task_id}"))
                        .unwrap(),
                )
                .send()
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            task["task"]["treatments"][0]["cells"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(task["task"]["treatments"][0]["cells"][0]["status"].is_null());
        let outcomes: serde_json::Value = decode(
            client
                .http
                .get(
                    client
                        .endpoint(&format!(
                            "v1/evals/worksets/{digest}/tasks/{task_id}/outcomes?limit=1"
                        ))
                        .unwrap(),
                )
                .send()
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(outcomes["total"], 2);
        assert_eq!(outcomes["outcomes"][0]["status"], "passed");
        assert_eq!(outcomes["nextCursor"], 1);
        let case = task["task"]["treatments"][0]["cells"][0]["detailId"]
            .as_str()
            .unwrap();
        let detail: serde_json::Value = decode(
            client
                .http
                .get(client.endpoint(&format!("v1/evals/cases/{case}")).unwrap())
                .send()
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(detail["status"], "passed");
        assert_eq!(detail["prompt"], "do it");
        let artifacts = directory.path().join("state/artifacts");
        assert_eq!(count_named_files(&artifacts, "events.jsonl"), 2);
        assert_eq!(count_named_files(&artifacts, "trajectory.json"), 2);
        assert_eq!(count_named_files(&artifacts, "reward.txt"), 2);
        assert_eq!(count_named_files(&artifacts, "rootfs.ext4"), 0);
        assert_eq!(count_named_files(&artifacts, "result.json"), 0);
        assert_eq!(count_named_files(&artifacts, "fixture.json"), 0);
        assert_eq!(count_named_files(&artifacts, "config.json"), 0);
        assert_eq!(count_files_with_suffix(&artifacts, ".tar"), 0);
        assert_eq!(count_files_with_suffix(&artifacts, ".tar.zst"), 0);
        assert!(matches!(
            client.claim(&selection).await.unwrap(),
            RemoteClaim::Complete
        ));
        server.abort();
    }

    fn count_named_files(directory: &Path, name: &str) -> usize {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .map(|path| {
                if path.is_dir() {
                    count_named_files(&path, name)
                } else {
                    usize::from(path.file_name().is_some_and(|file| file == name))
                }
            })
            .sum()
    }

    fn count_files_with_suffix(directory: &Path, suffix: &str) -> usize {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .map(|path| {
                if path.is_dir() {
                    count_files_with_suffix(&path, suffix)
                } else {
                    usize::from(path.to_string_lossy().ends_with(suffix))
                }
            })
            .sum()
    }

    #[tokio::test]
    async fn unreachable_worker_is_reclaimed_and_its_stale_token_is_fenced() {
        let (_directory, client, selection, server) =
            fixture_with_policy(Duration::from_secs(30), Duration::from_millis(20), 2).await;
        let RemoteClaim::Prepare {
            lease: preparation, ..
        } = client.claim(&selection).await.unwrap()
        else {
            panic!("first worker should prepare");
        };
        client.prepared(&preparation).await.unwrap();

        let RemoteClaim::Run {
            lease: stale,
            repetition,
            ..
        } = client.claim(&selection).await.unwrap()
        else {
            panic!("first worker should run");
        };
        tokio::time::sleep(Duration::from_millis(140)).await;

        let RemoteClaim::Run {
            lease: replacement,
            repetition: replacement_repetition,
            ..
        } = client.claim(&selection).await.unwrap()
        else {
            panic!("expired work should be reclaimed");
        };
        assert_eq!(replacement_repetition, repetition);
        assert!(matches!(
            client.retry(&stale, "late worker").await,
            Err(CoordinatorError::Rejected {
                status: StatusCode::NOT_FOUND,
                ..
            })
        ));
        client.retry(&replacement, "test cleanup").await.unwrap();
        server.abort();
    }

    #[test]
    fn plain_http_is_limited_to_loopback_addresses() {
        assert!(CoordinatorClient::new("http://192.0.2.1:8789").is_err());
        assert!(CoordinatorClient::new("http://100.64.0.1:8789").is_err());
        assert!(CoordinatorClient::new("http://100.127.255.255:8789").is_err());
        assert!(CoordinatorClient::new("http://127.0.0.1:8789").is_ok());
        assert!(CoordinatorClient::new("http://[::1]:8789").is_ok());
        assert!(CoordinatorClient::new("http://localhost:8789").is_ok());
        assert!(CoordinatorClient::new("https://evals.example").is_ok());
    }
}
