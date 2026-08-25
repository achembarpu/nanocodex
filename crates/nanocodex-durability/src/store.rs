use std::{future::Future, pin::Pin};

/// Fresh, unguessable identity proposed by a journal owner.
#[derive(Clone, Debug, Eq, Hash, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(transparent)]
pub struct OwnerId(String);

impl OwnerId {
    /// Generates a fresh UUIDv7 owner identity.
    pub fn new() -> Self {
        Self(uuid::Uuid::now_v7().to_string())
    }

    /// Returns the encoded owner identity.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for OwnerId {
    fn default() -> Self {
        Self::new()
    }
}

/// Authority installed by one successful owner acquisition.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct OwnerToken {
    owner_id: OwnerId,
    fence: u64,
}

impl OwnerToken {
    /// Reconstructs a token returned by an authoritative host store.
    pub const fn new(owner_id: OwnerId, fence: u64) -> Self {
        Self { owner_id, fence }
    }

    /// Returns the identity installed by this acquisition.
    pub const fn owner_id(&self) -> &OwnerId {
        &self.owner_id
    }

    /// Returns the monotonically increasing fencing generation.
    pub const fn fence(&self) -> u64 {
        self.fence
    }
}

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

/// One owner acquisition and the journal snapshot read in the same transaction.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct OwnedJournal {
    /// Newly installed owner authority.
    pub owner: OwnerToken,
    /// Self-consistent journal contents observed by that acquisition.
    pub journal: StoredJournal,
}

/// Host-store failure.
///
/// Only [`StoreError::NotCommitted`] promises that retrying the same operation
/// is safe. Every other mutation failure requires reopening from authoritative
/// state or resolving the structural conflict.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum StoreError {
    /// A newer or different owner holds authority for this journal.
    #[error("durability journal owner was fenced")]
    Fenced,
    /// Another writer advanced the journal.
    #[error("durability journal revision conflict: expected {expected}, found {actual}")]
    Conflict {
        /// Revision supplied by the caller.
        expected: u64,
        /// Revision currently retained by the store.
        actual: u64,
    },
    /// The host guarantees that the requested operation made no durable change.
    #[error("durability store operation was not committed: {0}")]
    NotCommitted(String),
    /// The selected storage backend failed.
    ///
    /// A mutation returning this variant has an unknown outcome. The session
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
/// `acquire_owner` must atomically increment retained fencing authority, install
/// the supplied identity, and load one self-consistent journal. `append` must
/// check that authority before comparing the journal revision in the same
/// transaction, retain the payload, and advance the revision by one.
#[cfg(not(target_family = "wasm"))]
pub trait JournalStore: Send {
    /// Acquires exclusive authority and loads one complete journal.
    fn acquire_owner<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedJournal, StoreError>>;

    /// Atomically appends one opaque Rust-owned batch.
    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner: &'a OwnerToken,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>>;

    /// Atomically replaces the retained batch prefix with one equivalent
    /// checkpoint at the unchanged current revision.
    fn compact<'a>(
        &'a mut self,
        _journal_id: &'a str,
        _owner: &'a OwnerToken,
        _expected_revision: u64,
        _payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async {
            Err(StoreError::NotCommitted(
                "durability store does not support journal compaction".to_owned(),
            ))
        })
    }
}

/// Minimal host-owned persistence contract.
///
/// `acquire_owner` must atomically increment retained fencing authority, install
/// the supplied identity, and load one self-consistent journal. `append` must
/// check that authority before comparing the journal revision in the same
/// transaction, retain the payload, and advance the revision by one.
#[cfg(target_family = "wasm")]
pub trait JournalStore {
    /// Acquires exclusive authority and loads one complete journal.
    fn acquire_owner<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedJournal, StoreError>>;

    /// Atomically appends one opaque Rust-owned batch.
    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner: &'a OwnerToken,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>>;

    /// Atomically replaces the retained batch prefix with one equivalent
    /// checkpoint at the unchanged current revision.
    fn compact<'a>(
        &'a mut self,
        _journal_id: &'a str,
        _owner: &'a OwnerToken,
        _expected_revision: u64,
        _payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async {
            Err(StoreError::NotCommitted(
                "durability store does not support journal compaction".to_owned(),
            ))
        })
    }
}
