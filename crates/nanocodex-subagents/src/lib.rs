//! Reusable, application-composed subagent tools and task-tree runtime.

mod capacity;
mod harness;
mod message;
mod model;
mod platform;
mod runtime;
mod task_tree;
mod tools;

pub use model::{
    AgentDescriptor, AgentId, AgentMessage, AgentMessageUpdate, AgentStatus, AgentThread,
    AgentUpdate, MessageDeliveryState, MessageDisposition, MessageId, MessagePriority,
    MessagePurpose, MessageSender, ScopedAgentUpdate, SubagentRuntimeId, ThreadId,
};
pub use runtime::{AgentSummary, Registry, SubagentControl, channel};
pub use tools::{
    AgentStartReport, AgentTask, AgentToolResult, install_tools, start_agent, start_agent_with,
};

/// Default maximum number of active turns in one task tree.
pub const DEFAULT_MAX_SUBAGENTS: usize = 32;
