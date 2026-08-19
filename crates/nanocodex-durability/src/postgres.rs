use tokio_postgres::Client;

use crate::{JournalStore, StoreError, StoreFuture, StoredBatch, StoredJournal};

/// Postgres-backed journal store.
pub struct PostgresStore {
    client: Client,
}

impl PostgresStore {
    /// Initializes the current journal schema using a caller-driven Postgres client.
    pub async fn new(client: Client) -> Result<Self, StoreError> {
        let store = Self { client };
        store
            .client
            .batch_execute(
                "CREATE TABLE IF NOT EXISTS nanocodex_journals (
                   journal_id TEXT PRIMARY KEY,
                   revision BIGINT NOT NULL CHECK (revision >= 0)
                 );
                 CREATE TABLE IF NOT EXISTS nanocodex_journal_batches (
                   journal_id TEXT NOT NULL REFERENCES nanocodex_journals(journal_id),
                   revision BIGINT NOT NULL CHECK (revision > 0),
                   payload TEXT NOT NULL,
                   PRIMARY KEY (journal_id, revision)
                 );",
            )
            .await
            .map_err(backend)?;
        Ok(store)
    }
}

impl JournalStore for PostgresStore {
    fn load<'a>(
        &'a mut self,
        journal_id: &'a str,
    ) -> StoreFuture<'a, Result<StoredJournal, StoreError>> {
        Box::pin(async move {
            let revision = self
                .client
                .query_opt(
                    "SELECT revision FROM nanocodex_journals WHERE journal_id = $1",
                    &[&journal_id],
                )
                .await
                .map_err(backend)?
                .map_or(0_i64, |row| row.get(0));
            let rows = self
                .client
                .query(
                    "SELECT revision, payload FROM nanocodex_journal_batches
                     WHERE journal_id = $1 ORDER BY revision",
                    &[&journal_id],
                )
                .await
                .map_err(backend)?;
            let batches = rows
                .into_iter()
                .map(|row| {
                    let revision = row.get::<_, i64>(0);
                    Ok(StoredBatch {
                        revision: u64::try_from(revision).map_err(|error| {
                            StoreError::Backend(format!("invalid Postgres revision: {error}"))
                        })?,
                        payload: row.get(1),
                    })
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            Ok(StoredJournal {
                revision: u64::try_from(revision).map_err(|error| {
                    StoreError::Backend(format!("invalid Postgres revision: {error}"))
                })?,
                batches,
            })
        })
    }

    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let expected = i64::try_from(expected_revision)
                .map_err(|error| StoreError::Backend(error.to_string()))?;
            let transaction = self.client.transaction().await.map_err(backend)?;
            transaction
                .execute(
                    "INSERT INTO nanocodex_journals (journal_id, revision) VALUES ($1, 0)
                     ON CONFLICT (journal_id) DO NOTHING",
                    &[&journal_id],
                )
                .await
                .map_err(backend)?;
            let row = transaction
                .query_opt(
                    "UPDATE nanocodex_journals SET revision = revision + 1
                     WHERE journal_id = $1 AND revision = $2
                     RETURNING revision",
                    &[&journal_id, &expected],
                )
                .await
                .map_err(backend)?;
            let Some(row) = row else {
                let actual = transaction
                    .query_one(
                        "SELECT revision FROM nanocodex_journals WHERE journal_id = $1",
                        &[&journal_id],
                    )
                    .await
                    .map_err(backend)?
                    .get::<_, i64>(0);
                return Err(StoreError::Conflict {
                    expected: expected_revision,
                    actual: u64::try_from(actual)
                        .map_err(|error| StoreError::Backend(error.to_string()))?,
                });
            };
            let revision = row.get::<_, i64>(0);
            transaction
                .execute(
                    "INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
                     VALUES ($1, $2, $3)",
                    &[&journal_id, &revision, &payload],
                )
                .await
                .map_err(backend)?;
            transaction.commit().await.map_err(backend)?;
            u64::try_from(revision).map_err(|error| StoreError::Backend(error.to_string()))
        })
    }
}

fn backend(error: tokio_postgres::Error) -> StoreError {
    StoreError::Backend(error.to_string())
}
