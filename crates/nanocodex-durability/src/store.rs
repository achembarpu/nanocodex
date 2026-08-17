use std::{future::Future, pin::Pin};

/// One encoded append batch returned by a host store.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct StoredBatch {
    /// Monotonic journal revision assigned to this batch.
    pub revision: u64,
    /// Rust-owned JSON payload. Hosts must retain it byte-for-byte.
    pub payload: String,
}

/// Complete encoded journal returned by a host store.
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct StoredJournal {
    /// Current compare-and-append revision.
    pub revision: u64,
    /// Ordered append batches.
    pub batches: Vec<StoredBatch>,
}

/// Host-store failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum StoreError {
    /// Another writer advanced the journal.
    #[error("durability journal revision conflict: expected {expected}, found {actual}")]
    Conflict {
        /// Revision supplied by the caller.
        expected: u64,
        /// Revision currently retained by the store.
        actual: u64,
    },
    /// The host guarantees that the requested append made no durable change.
    #[error("durability append was not committed: {0}")]
    NotCommitted(String),
    /// The selected storage backend failed.
    ///
    /// An append returning this variant has an unknown outcome. The session
    /// owner stops and must be reopened from the host journal.
    #[error("durability store failed: {0}")]
    Backend(String),
}

/// Boxed host operation used by [`JournalStore`].
#[cfg(not(target_family = "wasm"))]
pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Boxed host operation used by [`JournalStore`].
#[cfg(target_family = "wasm")]
pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Minimal host-owned persistence contract.
///
/// `append` must atomically compare `expected_revision`, retain the payload,
/// advance the revision by one, and return that new revision.
#[cfg(not(target_family = "wasm"))]
pub trait JournalStore: Send {
    /// Loads one complete journal, returning revision zero when it does not exist.
    fn load<'a>(
        &'a mut self,
        journal_id: &'a str,
    ) -> StoreFuture<'a, Result<StoredJournal, StoreError>>;

    /// Atomically appends one opaque Rust-owned batch.
    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>>;
}

/// Minimal host-owned persistence contract.
///
/// `append` must atomically compare `expected_revision`, retain the payload,
/// advance the revision by one, and return that new revision.
#[cfg(target_family = "wasm")]
pub trait JournalStore {
    /// Loads one complete journal, returning revision zero when it does not exist.
    fn load<'a>(
        &'a mut self,
        journal_id: &'a str,
    ) -> StoreFuture<'a, Result<StoredJournal, StoreError>>;

    /// Atomically appends one opaque Rust-owned batch.
    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>>;
}
