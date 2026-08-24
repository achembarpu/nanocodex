use std::{collections::HashMap, future::Future};

use tokio::sync::{mpsc, oneshot};

#[cfg(not(target_family = "wasm"))]
use crate::Error;
use crate::{
    JournalStore, OwnedJournal, OwnerId, OwnerToken, StoreError, StoreFuture, StoredBatch,
    StoredJournal,
};

const COMMAND_CAPACITY: usize = 64;

enum Command {
    AcquireOwner {
        journal_id: String,
        owner_id: OwnerId,
        result: oneshot::Sender<Result<OwnedJournal, StoreError>>,
    },
    Append {
        journal_id: String,
        owner: OwnerToken,
        expected_revision: u64,
        payload: String,
        result: oneshot::Sender<Result<u64, StoreError>>,
    },
    Compact {
        journal_id: String,
        owner: OwnerToken,
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
            let mut owners = HashMap::<String, OwnerToken>::new();
            while let Some(command) = receiver.recv().await {
                match command {
                    Command::AcquireOwner {
                        journal_id,
                        owner_id,
                        result,
                    } => {
                        let fence = owners
                            .get(&journal_id)
                            .map_or(Some(1), |owner| owner.fence().checked_add(1));
                        let outcome = fence
                            .ok_or_else(|| {
                                StoreError::NotCommitted(
                                    "in-memory durability owner fence overflow".to_owned(),
                                )
                            })
                            .map(|fence| {
                                let owner = OwnerToken::new(owner_id, fence);
                                owners.insert(journal_id.clone(), owner.clone());
                                OwnedJournal {
                                    owner,
                                    journal: journals.get(&journal_id).cloned().unwrap_or_default(),
                                }
                            });
                        drop(result.send(outcome));
                    }
                    Command::Append {
                        journal_id,
                        owner,
                        expected_revision,
                        payload,
                        result,
                    } => {
                        let outcome = if owners.get(&journal_id) != Some(&owner) {
                            Err(StoreError::Fenced)
                        } else {
                            let journal = journals.entry(journal_id).or_default();
                            if journal.revision != expected_revision {
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
                            }
                        };
                        drop(result.send(outcome));
                    }
                    Command::Compact {
                        journal_id,
                        owner,
                        expected_revision,
                        payload,
                        result,
                    } => {
                        let outcome = if owners.get(&journal_id) != Some(&owner) {
                            Err(StoreError::Fenced)
                        } else {
                            let journal = journals.entry(journal_id).or_default();
                            if journal.revision != expected_revision {
                                Err(StoreError::Conflict {
                                    expected: expected_revision,
                                    actual: journal.revision,
                                })
                            } else if expected_revision == 0 {
                                Err(StoreError::NotCommitted(
                                    "cannot compact an empty in-memory durability journal"
                                        .to_owned(),
                                ))
                            } else {
                                journal.batches = vec![StoredBatch {
                                    revision: expected_revision,
                                    payload,
                                }];
                                Ok(expected_revision)
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
    fn acquire_owner<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedJournal, StoreError>> {
        Box::pin(async move {
            let (result, receiver) = oneshot::channel();
            self.commands
                .send(Command::AcquireOwner {
                    journal_id: journal_id.to_owned(),
                    owner_id,
                    result,
                })
                .await
                .map_err(|_| stopped())?;
            receiver.await.map_err(|_| stopped())?
        })
    }

    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner: &'a OwnerToken,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let (result, receiver) = oneshot::channel();
            self.commands
                .send(Command::Append {
                    journal_id: journal_id.to_owned(),
                    owner: owner.clone(),
                    expected_revision,
                    payload: payload.to_owned(),
                    result,
                })
                .await
                .map_err(|_| stopped())?;
            receiver.await.map_err(|_| stopped())?
        })
    }

    fn compact<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner: &'a OwnerToken,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let (result, receiver) = oneshot::channel();
            self.commands
                .send(Command::Compact {
                    journal_id: journal_id.to_owned(),
                    owner: owner.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acquisition_fences_stale_writer_before_revision_check() {
        let mut first = MemoryStore::new().unwrap();
        let mut second = first.clone();
        let first_owned = first
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        assert_eq!(first_owned.owner.fence(), 1);
        first
            .append("journal", &first_owned.owner, 0, "first")
            .await
            .unwrap();

        let second_owned = second
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        assert_eq!(second_owned.owner.fence(), 2);
        assert_eq!(second_owned.journal.revision, 1);
        assert_eq!(second_owned.journal.batches[0].payload, "first");
        assert_eq!(
            first
                .append("journal", &first_owned.owner, u64::MAX, "stale")
                .await,
            Err(StoreError::Fenced)
        );
    }

    #[tokio::test]
    async fn compaction_keeps_revision_and_fence_while_replacing_batches() {
        let mut store = MemoryStore::new().unwrap();
        let owned = store
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        store
            .append("journal", &owned.owner, 0, "first")
            .await
            .unwrap();
        store
            .append("journal", &owned.owner, 1, "second")
            .await
            .unwrap();
        assert_eq!(
            store
                .compact("journal", &owned.owner, 2, "checkpoint")
                .await,
            Ok(2)
        );

        let reopened = store
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        assert_eq!(reopened.journal.revision, 2);
        assert_eq!(
            reopened.journal.batches,
            vec![StoredBatch {
                revision: 2,
                payload: "checkpoint".to_owned(),
            }]
        );
        assert_eq!(
            store
                .compact("journal", &owned.owner, u64::MAX, "stale")
                .await,
            Err(StoreError::Fenced)
        );
    }

    #[test]
    fn owner_ids_are_fresh_uuid_v7_values() {
        let first = OwnerId::new();
        let second = OwnerId::new();
        assert_ne!(first, second);
        assert_eq!(first.as_str().as_bytes()[14], b'7');
        assert_eq!(second.as_str().as_bytes()[14], b'7');
    }
}
