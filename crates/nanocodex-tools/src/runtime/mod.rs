//! Declarative tool selection and the stateful per-agent execution runtime.

mod execution;
mod registry;
mod schema;
mod selection;

#[cfg(test)]
mod tests;

pub use execution::{ToolRuntime, ToolRuntimeControl};
pub(crate) use registry::ToolRegistry;
pub use schema::schema_for;
pub use selection::{
    DynamicToolProvider, ToolExposure, ToolSource, Tools, ToolsBuildError, ToolsBuilder,
};

use std::{
    any::Any,
    collections::{HashMap, HashSet},
    ffi::OsString,
    fmt,
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use async_trait::async_trait;
use futures_util::FutureExt;
use nanocodex_oai_api::tools::{Tool, ToolContext, ToolDefinition, ToolInput, ToolOutput};
use schemars::{JsonSchema, r#gen::SchemaSettings};
use serde_json::value::to_raw_value;
use serde_json::{Map, Value, json};
use tracing::{Instrument, info, info_span};

use crate::code_mode::{self, CodeModeExecution, CodeModeObserver};
pub use crate::hosted::OwnedToolContext;
pub use crate::runtime_config::{ImageGenerationConfig, WebSearchConfig};
use crate::{
    apply_patch, plan,
    shell::{self, ShellSessions},
    view_image,
};
use crate::{image_generation, web_search};

const CODEX_THREAD_ID_ENV_VAR: &str = "CODEX_THREAD_ID";

fn host_owned_name(name: &str) -> bool {
    matches!(name, "exec" | "wait")
}
