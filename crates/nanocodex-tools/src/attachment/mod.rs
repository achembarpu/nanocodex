//! Generic WebSocket attachment for one immutable [`Tools`] recipe.
//!
//! This boundary knows only a final WebSocket URL and bearer credential. Agent,
//! account, placement, and endpoint discovery remain the caller's responsibility.

mod driver;
mod protocol;

use std::{fmt, sync::Arc};
use tokio::sync::{mpsc, watch};
use url::{Host, Url};

use crate::{
    Tools,
    prepared::{PreparedToolError, PreparedToolRuntime, PreparedTools},
};

/// Transport-only destination for an attached tool executor.
#[derive(Clone)]
pub struct AttachmentTarget {
    endpoint: Url,
    bearer: Arc<str>,
}

impl AttachmentTarget {
    /// # Errors
    ///
    /// Rejects non-WebSocket URLs, embedded credentials, fragments, and empty
    /// bearer values.
    pub fn new(
        endpoint: impl AsRef<str>,
        bearer: impl Into<String>,
    ) -> Result<Self, AttachmentError> {
        let endpoint = Url::parse(endpoint.as_ref())
            .map_err(|error| AttachmentError::Transport(error.to_string().into()))?;
        if !matches!(endpoint.scheme(), "ws" | "wss")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(AttachmentError::Transport(
                "attachment target must be a final ws/wss URL without credentials or a fragment"
                    .into(),
            ));
        }
        if endpoint.scheme() == "ws" && !is_literal_loopback(&endpoint) {
            return Err(AttachmentError::Transport(
                "plaintext attachment targets require a literal loopback host; use wss otherwise"
                    .into(),
            ));
        }
        let bearer = bearer.into();
        if bearer.trim().is_empty() {
            return Err(AttachmentError::Authentication(
                "bearer credential must not be empty".into(),
            ));
        }
        Ok(Self {
            endpoint,
            bearer: bearer.into(),
        })
    }

    /// Returns the final WebSocket endpoint.
    #[must_use]
    pub const fn endpoint(&self) -> &Url {
        &self.endpoint
    }
}

impl fmt::Debug for AttachmentTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttachmentTarget")
            .field("endpoint", &self.endpoint)
            .field("bearer", &"[REDACTED]")
            .finish()
    }
}

/// Prepared connection from one complete [`Tools`] recipe.
pub struct AttachmentConnector {
    tools: Tools,
    target: AttachmentTarget,
}

impl Tools {
    /// Binds this exact immutable recipe to a transport target.
    #[must_use]
    pub const fn attach(self, target: AttachmentTarget) -> AttachmentConnector {
        AttachmentConnector {
            tools: self,
            target,
        }
    }
}

impl AttachmentConnector {
    /// Validates the recipe and starts its complete lifecycle in the background.
    ///
    /// # Errors
    ///
    /// Fails synchronously when the selected tools cannot produce an immutable
    /// attached catalog. Discovery and transport failures are reported through
    /// the returned handle while its driver initializes and reconnects.
    pub fn start(self) -> Result<(Attachment, AttachmentEvents), AttachmentError> {
        install_default_rustls_crypto_provider();
        let prepared = PreparedTools::prepare(&self.tools)?;
        let (command_tx, command_rx) = mpsc::channel(8);
        let (event_tx, event_rx) = mpsc::channel(128);
        let (status_tx, status_rx) = watch::channel(AttachmentStatus::Connecting);
        let (closed_tx, closed_rx) = watch::channel(None);
        let refs = Arc::new(HandleRefs { command_tx });
        tokio::spawn(initialize_and_run(
            prepared,
            self.target,
            command_rx,
            event_tx,
            status_tx,
            closed_tx,
        ));
        Ok((
            Attachment {
                refs,
                status: status_rx,
                closed: closed_rx,
            },
            AttachmentEvents { events: event_rx },
        ))
    }

    /// Prepares the exact catalog, connects, publishes it, and waits for its acknowledgement.
    ///
    /// # Errors
    ///
    /// Fails for non-attachable selections, discovery failures, invalid protocol
    /// frames, or endpoint rejection before readiness. Transient transport
    /// failures reconnect in the background.
    pub async fn connect(self) -> Result<(Attachment, AttachmentEvents), AttachmentError> {
        let (attachment, events) = self.start()?;
        attachment.wait_until_ready().await?;
        Ok((attachment, events))
    }
}

async fn initialize_and_run(
    prepared: PreparedTools,
    target: AttachmentTarget,
    mut command_rx: mpsc::Receiver<driver::Command>,
    event_tx: mpsc::Sender<AttachmentEvent>,
    status_tx: watch::Sender<AttachmentStatus>,
    closed_tx: watch::Sender<Option<Result<(), AttachmentError>>>,
) {
    let runtime = tokio::select! {
        biased;
        command = command_rx.recv() => {
            debug_assert!(matches!(command, Some(driver::Command::Detach) | None));
            let _ = closed_tx.send(Some(Ok(())));
            return;
        }
        initialized = PreparedToolRuntime::initialize(prepared) => match initialized {
            Ok(runtime) => Arc::new(runtime),
            Err(error) => {
                let _ = closed_tx.send(Some(Err(error.into())));
                return;
            }
        },
    };

    let config = (|| {
        let catalog = runtime.catalog()?;
        let tools = serde_json::to_value(catalog)
            .map_err(|error| AttachmentError::Catalog(error.to_string().into()))?;
        let names = tools
            .as_array()
            .and_then(|entries| {
                entries
                    .iter()
                    .map(|entry| {
                        entry
                            .pointer("/definition/name")
                            .and_then(serde_json::Value::as_str)
                    })
                    .collect::<Option<Vec<_>>>()
            })
            .ok_or_else(|| AttachmentError::Catalog("catalog tool name is missing".into()))?;
        crate::selection::validate_public_tool_catalog_names(names)
            .map_err(|error| AttachmentError::Catalog(error.to_string().into()))?;
        Ok::<_, AttachmentError>(driver::Config {
            endpoint: target.endpoint,
            authorization: format!("Bearer {}", target.bearer).into(),
            tools,
        })
    })();
    let config = match config {
        Ok(config) => config,
        Err(error) => {
            runtime.shutdown().await;
            let _ = closed_tx.send(Some(Err(error)));
            return;
        }
    };
    driver::run(config, runtime, command_rx, event_tx, status_tx, closed_tx).await;
}

fn is_literal_loopback(endpoint: &Url) -> bool {
    match endpoint.host() {
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

fn install_default_rustls_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

struct HandleRefs {
    command_tx: mpsc::Sender<driver::Command>,
}

impl Drop for HandleRefs {
    fn drop(&mut self) {
        let _ = self.command_tx.try_send(driver::Command::Detach);
    }
}

/// Cheap live attachment handle.
///
/// Clones share one attachment. Dropping the last handle detaches the executor;
/// dropping its independent [`AttachmentEvents`] observer does not.
#[derive(Clone)]
pub struct Attachment {
    refs: Arc<HandleRefs>,
    status: watch::Receiver<AttachmentStatus>,
    closed: watch::Receiver<Option<Result<(), AttachmentError>>>,
}

impl fmt::Debug for Attachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Attachment")
            .field("status", &self.status())
            .finish_non_exhaustive()
    }
}

impl Attachment {
    /// Returns the latest observed lifecycle state.
    #[must_use]
    pub fn status(&self) -> AttachmentStatus {
        self.status.borrow().clone()
    }

    /// Explicitly detaches and waits for terminal cleanup.
    pub async fn detach(self) -> Result<(), AttachmentError> {
        let _ = self.refs.command_tx.try_send(driver::Command::Detach);
        self.closed().await
    }

    /// Waits for authoritative terminal closure.
    pub async fn closed(&self) -> Result<(), AttachmentError> {
        let mut closed = self.closed.clone();
        loop {
            if let Some(result) = closed.borrow().clone() {
                return result;
            }
            if closed.changed().await.is_err() {
                return closed
                    .borrow()
                    .clone()
                    .unwrap_or(Err(AttachmentError::Closed));
            }
        }
    }

    async fn wait_until_ready(&self) -> Result<(), AttachmentError> {
        let mut status = self.status.clone();
        loop {
            let current = status.borrow().clone();
            match current {
                AttachmentStatus::Ready => return Ok(()),
                AttachmentStatus::Fenced => return self.closed().await,
                _ => {}
            }
            tokio::select! {
                changed = status.changed() => if changed.is_err() { return self.closed().await },
                result = self.closed() => return result,
            }
        }
    }
}

/// Best-effort ordered observations from one attachment.
///
/// Observation never applies backpressure to execution or protocol progress.
/// When this bounded stream lags, events may be dropped. Use [`Attachment::status`]
/// and [`Attachment::closed`] for authoritative lifecycle state.
pub struct AttachmentEvents {
    events: mpsc::Receiver<AttachmentEvent>,
}

impl fmt::Debug for AttachmentEvents {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttachmentEvents")
            .finish_non_exhaustive()
    }
}

impl AttachmentEvents {
    /// Receives the next available observation.
    pub async fn recv(&mut self) -> Option<AttachmentEvent> {
        self.events.recv().await
    }
}

/// Latest attachment connection state.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum AttachmentStatus {
    /// A connection or reconnect is in progress.
    Connecting,
    /// The exact catalog was acknowledged.
    Ready,
    /// The transport is temporarily disconnected.
    Disconnected,
    /// The remote endpoint authoritatively rejected this socket.
    Fenced,
}

/// Best-effort ordered lifecycle and call observation.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum AttachmentEvent {
    /// A connection or reconnect attempt started.
    Connecting,
    /// The endpoint accepted the socket and immutable catalog.
    Attached,
    /// The immutable catalog was acknowledged.
    CatalogPublished {
        /// Number of entries in the exact catalog.
        tool_count: usize,
    },
    /// One pinned invocation was admitted.
    CallStarted {
        /// Remote call identity.
        call_id: Box<str>,
        /// Exact catalog name.
        name: Box<str>,
    },
    /// One admitted invocation reached a transport outcome.
    CallCompleted {
        /// Remote call identity.
        call_id: Box<str>,
        /// Conservative transport classification.
        outcome: AttachmentCallOutcome,
    },
    /// The executor detached normally.
    Detached {
        /// Human-readable terminal reason.
        reason: Box<str>,
    },
    /// The endpoint authoritatively rejected this executor.
    Fenced {
        /// Human-readable protocol or lease violation.
        reason: Box<str>,
    },
}

/// Transport-level terminal classification for one invocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum AttachmentCallOutcome {
    /// A complete tool output was published.
    Completed,
    /// Execution was not admitted or the tool was unavailable.
    Unavailable,
    /// Side effects may have happened without a publishable exact result.
    Ambiguous,
    /// Execution was cancelled before side effects were admitted.
    Cancelled,
}

/// Typed attachment preparation, transport, and protocol failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum AttachmentError {
    /// The credential was malformed or rejected.
    #[error("attachment authentication failed: {0}")]
    Authentication(Box<str>),
    /// The recipe could not produce an exact immutable catalog.
    #[error("attached catalog failed: {0}")]
    Catalog(Box<str>),
    /// The remote endpoint rejected this socket or its protocol frames.
    #[error("attachment was fenced: {0}")]
    Fenced(Box<str>),
    /// The WebSocket connection or frame exchange failed.
    #[error("attachment transport failed: {0}")]
    Transport(Box<str>),
    /// The attachment terminated before the awaited operation completed.
    #[error("attachment is closed")]
    Closed,
}

impl From<PreparedToolError> for AttachmentError {
    fn from(error: PreparedToolError) -> Self {
        Self::Catalog(error.to_string().into())
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod target_tests {
    use super::AttachmentTarget;

    #[test]
    fn plaintext_targets_require_literal_loopback_hosts() {
        for endpoint in [
            "ws://localhost/tools",
            "ws://127.0.0.1/tools",
            "ws://127.255.255.254/tools",
            "ws://[::1]/tools",
        ] {
            assert!(
                AttachmentTarget::new(endpoint, "secret").is_ok(),
                "{endpoint}"
            );
        }

        for endpoint in [
            "ws://example.com/tools",
            "ws://localhost.example/tools",
            "ws://[::ffff:127.0.0.1]/tools",
            "ws://192.168.1.10/tools",
        ] {
            assert!(
                AttachmentTarget::new(endpoint, "secret").is_err(),
                "{endpoint}"
            );
        }

        assert!(AttachmentTarget::new("wss://example.com/tools", "secret").is_ok());
    }
}
