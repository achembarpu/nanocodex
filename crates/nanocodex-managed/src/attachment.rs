//! Private caller-owned tool attachment supervisor.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use nanocodex_tools::{
    Tools,
    attachment::{Attachment, AttachmentError, AttachmentTarget},
};
use tokio::{
    sync::watch,
    time::{Duration, sleep},
};

const INITIAL_BACKOFF: Duration = Duration::from_millis(100);
const MAX_BACKOFF: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(crate) struct AttachmentSupervisor {
    requested: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
    outcome: watch::Receiver<Option<Result<(), AttachmentError>>>,
}

impl AttachmentSupervisor {
    pub(crate) async fn connect(
        tools: Tools,
        target: AttachmentTarget,
    ) -> Result<Self, AttachmentError> {
        let attachment = match tools.clone().attach(target.clone()).connect().await {
            Ok((attachment, _events)) => Some(attachment),
            Err(error) if retryable(&error) => None,
            Err(error) => return Err(error),
        };
        let (stop, stop_rx) = watch::channel(false);
        let (outcome_tx, outcome) = watch::channel(None);
        tokio::spawn(run(tools, target, attachment, stop_rx, outcome_tx));
        Ok(Self {
            requested: Arc::new(AtomicBool::new(false)),
            stop,
            outcome,
        })
    }

    pub(crate) async fn shutdown(&self) -> Result<(), AttachmentError> {
        if self
            .requested
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.stop.send_replace(true);
        }
        let mut outcome = self.outcome.clone();
        loop {
            if let Some(outcome) = outcome.borrow().clone() {
                return outcome;
            }
            if outcome.changed().await.is_err() {
                return outcome
                    .borrow()
                    .clone()
                    .unwrap_or(Err(AttachmentError::Closed));
            }
        }
    }
}

async fn run(
    tools: Tools,
    target: AttachmentTarget,
    mut attachment: Option<Attachment>,
    mut stop: watch::Receiver<bool>,
    outcome: watch::Sender<Option<Result<(), AttachmentError>>>,
) {
    let mut backoff = INITIAL_BACKOFF;
    let result = loop {
        let current = match attachment.take() {
            Some(attachment) => attachment,
            None => {
                let connected = tokio::select! {
                    biased;
                    changed = stop.changed() => {
                        if changed.is_err() || *stop.borrow() {
                            break Ok(());
                        }
                        continue;
                    }
                    connected = tools.clone().attach(target.clone()).connect() => connected,
                };
                match connected {
                    Ok((attachment, _events)) => {
                        backoff = INITIAL_BACKOFF;
                        attachment
                    }
                    Err(error) if retryable(&error) => {
                        if wait_or_stop(backoff, &mut stop).await {
                            break Ok(());
                        }
                        backoff = backoff.saturating_mul(2).min(MAX_BACKOFF);
                        continue;
                    }
                    Err(error) => break Err(error),
                }
            }
        };

        match drain_until_closed(current, &mut stop).await {
            Ok(()) => break Ok(()),
            Err(error) if retryable(&error) => {
                if wait_or_stop(backoff, &mut stop).await {
                    break Ok(());
                }
                backoff = backoff.saturating_mul(2).min(MAX_BACKOFF);
            }
            Err(error) => break Err(error),
        }
    };
    outcome.send_replace(Some(result));
}

async fn drain_until_closed(
    attachment: Attachment,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), AttachmentError> {
    loop {
        let closed = attachment.clone();
        tokio::select! {
            biased;
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return attachment.detach().await;
                }
            }
            result = closed.closed() => return result,
        }
    }
}

async fn wait_or_stop(delay: Duration, stop: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        biased;
        changed = stop.changed() => changed.is_err() || *stop.borrow(),
        () = sleep(delay) => false,
    }
}

const fn retryable(error: &AttachmentError) -> bool {
    matches!(
        error,
        AttachmentError::Transport(_) | AttachmentError::Closed
    )
}
