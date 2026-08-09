// Derived from clabby/tact@1d9ccaefd1d8613dab020812af04a91cd9b4c52c (Apache-2.0).
// Modified for Nanocodex's CLI-owned module paths and runtime wiring.

#![allow(dead_code, unused_imports)]

//! Reusable child-agent tools and the typed runtime/UI update boundary.

mod capacity;
mod harness;
mod message;
mod model;
mod runtime;
mod task_tree;
mod tools;

pub(crate) use model::{
    AgentDescriptor, AgentId, AgentMessage, AgentMessageUpdate, AgentStatus, AgentThread,
    AgentUpdate, MessageDeliveryState, MessageDisposition, MessageId, MessagePriority,
    MessagePurpose, MessageSender, ScopedAgentUpdate, SubagentRuntimeId, ThreadId,
};
use std::sync::Arc;

use tokio::{sync::mpsc, task::JoinHandle};

pub(crate) use runtime::{Registry, SubagentControl, channel};
pub(crate) use tools::install_tools;

pub(crate) const DEFAULT_MAX_SUBAGENTS: usize = 32;

pub(crate) struct ChildAgents {
    root_session_id: String,
    control: SubagentControl,
    update_task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

impl ChildAgents {
    pub(crate) fn new(
        root_session_id: String,
        control: SubagentControl,
        mut updates: mpsc::UnboundedReceiver<ScopedAgentUpdate>,
    ) -> Arc<Self> {
        let update_task = tokio::spawn(async move { while updates.recv().await.is_some() {} });
        Arc::new(Self {
            root_session_id,
            control,
            update_task: tokio::sync::Mutex::new(Some(update_task)),
        })
    }

    pub(crate) async fn shutdown(&self) {
        self.control.close_all(&self.root_session_id).await;
        if let Some(update_task) = self.update_task.lock().await.take() {
            update_task.abort();
            drop(update_task.await);
        }
    }
}
