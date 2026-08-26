#![doc = include_str!("../README.md")]
#![deny(missing_docs, rustdoc::broken_intra_doc_links)]
#![cfg_attr(docsrs, feature(doc_cfg))]

pub use nanocodex_agent::{
    AgentEvents, AgentSessionContext, CostStatus, EstimatedUsdCost, ExecutionPolicyDisposition,
    Nanocodex, NanocodexBuilder, NanocodexError, PromptRequest, PromptRoute, ReportedTurnUsage,
    ServiceTier, Turn, TurnControl, TurnResult, TurnUsage, UsdAmount,
};
pub use nanocodex_durability::DurableAgentExt;
pub use nanocodex_oai_api::{Model, OpenAi, ReasoningMode, Thinking};
#[cfg(not(target_family = "wasm"))]
#[cfg_attr(docsrs, doc(cfg(not(target_family = "wasm"))))]
pub use nanocodex_tools::tool;
pub use nanocodex_tools::{Tool, Tools};

/// Owned agent lifecycle, builders, turns, branching, and snapshots.
///
/// Provider and tool-runtime APIs keep their canonical detailed paths under
/// [`crate::oai`] and [`crate::tools`].
pub mod agent {
    pub use crate::durability;
    #[cfg(not(target_family = "wasm"))]
    #[cfg_attr(docsrs, doc(cfg(not(target_family = "wasm"))))]
    pub use nanocodex_agent::rollout;
    pub use nanocodex_agent::{
        AgentEvents, AgentHandle, AgentSessionContext, CostStatus, EstimatedUsdCost,
        ExecutionEnvironment, ExecutionPolicyDisposition, Nanocodex, NanocodexBuilder,
        NanocodexError, PromptRequest, PromptRoute, ReportedTurnUsage, Result, ServiceTier,
        SpawnOptions, Turn, TurnControl, TurnResult, TurnUsage, UsdAmount, events, execution,
        input, session, usage,
    };
}

/// Portable durable execution policy and host-store contracts.
#[doc(inline)]
pub use nanocodex_durability as durability;

/// Tower-native OpenAI Responses client, sessions, protocol, and transport.
#[doc(inline)]
pub use nanocodex_oai_api as oai;

/// Tool registry, built-ins, MCP, tool search, and Code Mode.
#[doc(inline)]
pub use nanocodex_tools as tools;

/// Application-owned tracing and OpenTelemetry setup.
#[cfg(all(not(target_family = "wasm"), feature = "observability"))]
#[cfg_attr(
    docsrs,
    doc(cfg(all(not(target_family = "wasm"), feature = "observability")))
)]
#[doc(inline)]
pub use nanocodex_observability as observability;

/// Common imports for the golden owned-agent path.
pub mod prelude {
    #[cfg(not(target_family = "wasm"))]
    #[cfg_attr(docsrs, doc(cfg(not(target_family = "wasm"))))]
    pub use crate::tool;
    pub use crate::{DurableAgentExt, Model, Nanocodex, NanocodexBuilder, OpenAi, Tool, Tools};
}

#[cfg(not(target_family = "wasm"))]
#[doc(hidden)]
pub mod __private {
    pub use nanocodex_tools::__private::*;
}
