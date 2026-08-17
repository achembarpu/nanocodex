use std::{collections::HashMap, future::Future};

use tokio::sync::{mpsc, oneshot};

#[cfg(not(target_family = "wasm"))]
use crate::Error;
use crate::{JournalStore, StoreError, StoreFuture, StoredBatch, StoredJournal};

const COMMAND_CAPACITY: usize = 64;

enum Command {
    Load {
        journal_id: String,
        result: oneshot::Sender<StoredJournal>,
    },
    Append {
        journal_id: String,
        expected_revision: u64,
        payload: String,
        result: oneshot::Sender<Result<u64, StoreError>>,
    },
}

/// Process-local store useful for tests and ephemeral native or WASM sessions.
///
/// One spawned task owns all journal maps. Clones are command handles, allowing
/// a new [`crate::DurableSession`] driver to reopen the same process-local data
/// without exposing shared mutable state.
#[derive(Clone)]
pub struct MemoryStore {
    commands: mpsc::Sender<Command>,
}

impl MemoryStore {
    /// Creates an empty in-memory store and spawns its owning task.
    pub fn new() -> crate::Result<Self> {
        let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
        let driver = async move {
            let mut journals = HashMap::<String, StoredJournal>::new();
            while let Some(command) = receiver.recv().await {
                match command {
                    Command::Load { journal_id, result } => {
                        drop(result.send(journals.get(&journal_id).cloned().unwrap_or_default()));
                    }
                    Command::Append {
                        journal_id,
                        expected_revision,
                        payload,
                        result,
                    } => {
                        let journal = journals.entry(journal_id).or_default();
                        let outcome = if journal.revision != expected_revision {
                            Err(StoreError::Conflict {
                                expected: expected_revision,
                                actual: journal.revision,
                            })
                        } else {
                            match journal.revision.checked_add(1) {
                                Some(revision) => {
                                    journal.batches.push(StoredBatch { revision, payload });
                                    journal.revision = revision;
                                    Ok(revision)
                                }
                                None => Err(StoreError::NotCommitted(
                                    "in-memory durability revision overflow".to_owned(),
                                )),
                            }
                        };
                        drop(result.send(outcome));
                    }
                }
            }
        };
        spawn_driver(driver)?;
        Ok(Self { commands })
    }
}

impl JournalStore for MemoryStore {
    fn load<'a>(
        &'a mut self,
        journal_id: &'a str,
    ) -> StoreFuture<'a, Result<StoredJournal, StoreError>> {
        Box::pin(async move {
            let (result, receiver) = oneshot::channel();
            self.commands
                .send(Command::Load {
                    journal_id: journal_id.to_owned(),
                    result,
                })
                .await
                .map_err(|_| stopped())?;
            receiver.await.map_err(|_| stopped())
        })
    }

    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let (result, receiver) = oneshot::channel();
            self.commands
                .send(Command::Append {
                    journal_id: journal_id.to_owned(),
                    expected_revision,
                    payload: payload.to_owned(),
                    result,
                })
                .await
                .map_err(|_| stopped())?;
            receiver.await.map_err(|_| stopped())?
        })
    }
}

fn stopped() -> StoreError {
    StoreError::Backend("in-memory durability store stopped".to_owned())
}

#[cfg(not(target_family = "wasm"))]
fn spawn_driver(driver: impl Future<Output = ()> + Send + 'static) -> crate::Result<()> {
    let runtime = tokio::runtime::Handle::try_current().map_err(|_| Error::RuntimeUnavailable)?;
    drop(runtime.spawn(driver));
    Ok(())
}

#[cfg(target_family = "wasm")]
fn spawn_driver(driver: impl Future<Output = ()> + 'static) -> crate::Result<()> {
    wasm_bindgen_futures::spawn_local(driver);
    Ok(())
}
