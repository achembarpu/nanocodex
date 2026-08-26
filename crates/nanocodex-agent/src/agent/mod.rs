use std::{
    collections::VecDeque,
    fmt,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
};

use futures_util::Stream;
use nanocodex_oai_api::{
    __private::{EventSink, ModelConfig, ResponsesServiceFactory, into_openai_parts},
    Model, OpenAi, Prompt, ReasoningMode, ResponseError, Thinking,
    auth::OpenAiAuthMode,
    events::{AgentEvent, AgentEvents},
    session::SessionId,
    tower::{ResponsesAttempt, ResponsesClient, ResponsesServiceResponse, StandardServiceFactory},
    transport::{ResponsesHistory, ResponsesTransport, TransportStats},
};
use nanocodex_tools::Tools;
use nanocodex_tools::ToolsBuildError;
use tokio::sync::{mpsc, oneshot, watch};
use tower::Service;
use tracing::{Instrument, info, info_span};

use crate::prompt_cache::{ModelPromptCache, SharedPromptCache};
use crate::{
    NanocodexError, Result,
    model::run::{
        CompletedModelTurn, HistoryCheckpoint, ModelCheckpoint, ModelCompactOutcome, ModelRun,
        ModelTurnOutcome, PreparedCheckpoint, prepare_checkpoint, prepare_history_checkpoint,
        prepare_resumed_checkpoint,
    },
    session::{CommittedSession, SessionResume, SessionSnapshot},
    usage::TurnUsage,
};

const COMMAND_CAPACITY: usize = 8;
const STEER_CAPACITY: usize = 8;

type ToolsFactory =
    Arc<dyn Fn(AgentHandle) -> std::result::Result<Tools, ToolsBuildError> + Send + Sync>;

enum InitialResume {
    Exact(Box<ModelCheckpoint>),
    History(Box<HistoryCheckpoint>),
}

impl InitialResume {
    fn workspace(&self) -> &str {
        match self {
            Self::Exact(checkpoint) => checkpoint.workspace(),
            Self::History(resume) => &resume.workspace,
        }
    }

    fn history_len(&self) -> usize {
        match self {
            Self::Exact(checkpoint) => checkpoint.history().len(),
            Self::History(resume) => resume.history.len(),
        }
    }
}

#[derive(Clone)]
enum ToolsConfiguration {
    Shared(Tools),
    PerAgent(ToolsFactory),
}

impl ToolsConfiguration {
    fn materialize(&self, agent_handle: AgentHandle) -> Result<Tools> {
        match self {
            Self::Shared(tools) => Ok(tools.clone()),
            Self::PerAgent(factory) => factory(agent_handle).map_err(Into::into),
        }
    }
}

pub mod backend;
mod builder;
mod context_source;
mod driver;
pub mod execution;
mod executor;
mod handle;
mod session_context;
mod spawn;
mod turn;

pub use backend::BuilderBackend;
pub use builder::NanocodexBuilder;
pub use context_source::ExecutionEnvironment;
pub use handle::{AgentHandle, Nanocodex};
pub use session_context::AgentSessionContext;
use turn::TurnCheckpoint;
pub use turn::{PromptRequest, PromptRoute, SpawnOptions, Turn, TurnControl, TurnResult};

use backend::{BackendRuntime, LocalLifecycle};
use builder::{CodexCompatibility, PromptCacheConfig};
pub(crate) use context_source::ContextSource;
use context_source::ContextSourceConfig;
use driver::{AgentDriver, AgentOrigin, BranchSpawner, DriverShutdown};
use execution::{Execution, ExecutionConfig};
pub(crate) use execution::{ExecutionStep, ExecutionSteps};
pub(crate) use executor::{AgentFactory, AgentSend};
use executor::{ServiceFactory, spawn_driver};
use handle::request_command;
use spawn::{build_agent, spawn_agent_driver, validate};
use turn::{Command, ExecutionOperation, PromptRouteKind, QueuedTurn, TurnKey};
