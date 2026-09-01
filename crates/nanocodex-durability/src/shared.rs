use std::future::Future;

use tokio::sync::{mpsc, oneshot};

use crate::{Error, OwnedState, OwnerId, OwnerToken, StateStore, StoreError, StoreFuture};

const COMMAND_CAPACITY: usize = 64;

enum Command {
    Acquire {
        state_id: String,
        owner_id: OwnerId,
        result: oneshot::Sender<Result<OwnedState, StoreError>>,
    },
    Replace {
        state_id: String,
        owner: OwnerToken,
        expected_revision: u64,
        payload: String,
        result: oneshot::Sender<Result<u64, StoreError>>,
    },
}

/// Cloneable serialized access to one caller-owned store.
///
/// A durable root and every independently fenced spawned agent use separate
/// state IDs through this handle without requiring backend stores themselves to
/// be cloneable or concurrently mutable.
#[derive(Clone)]
pub(crate) struct SharedStore {
    commands: mpsc::Sender<Command>,
}

impl SharedStore {
    pub(crate) fn new<S>(mut store: S) -> crate::Result<Self>
    where
        S: StateStore + 'static,
    {
        let (commands, mut receiver) = mpsc::channel(COMMAND_CAPACITY);
        spawn_driver(async move {
            while let Some(command) = receiver.recv().await {
                match command {
                    Command::Acquire {
                        state_id,
                        owner_id,
                        result,
                    } => {
                        drop(result.send(store.acquire(&state_id, owner_id).await));
                    }
                    Command::Replace {
                        state_id,
                        owner,
                        expected_revision,
                        payload,
                        result,
                    } => {
                        drop(
                            result.send(
                                store
                                    .replace(&state_id, &owner, expected_revision, &payload)
                                    .await,
                            ),
                        );
                    }
                }
            }
        })?;
        Ok(Self { commands })
    }
}

impl StateStore for SharedStore {
    fn acquire<'a>(
        &'a mut self,
        state_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedState, StoreError>> {
        Box::pin(async move {
            let (result, receiver) = oneshot::channel();
            self.commands
                .send(Command::Acquire {
                    state_id: state_id.to_owned(),
                    owner_id,
                    result,
                })
                .await
                .map_err(|_| stopped())?;
            receiver.await.map_err(|_| stopped())?
        })
    }

    fn replace<'a>(
        &'a mut self,
        state_id: &'a str,
        owner: &'a OwnerToken,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let (result, receiver) = oneshot::channel();
            self.commands
                .send(Command::Replace {
                    state_id: state_id.to_owned(),
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
    StoreError::Backend("shared durability store stopped".to_owned())
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
