use std::path::Path;

use rusqlite::{Connection, OptionalExtension as _, TransactionBehavior, params};

use crate::{JournalStore, StoreError, StoreFuture, StoredBatch, StoredJournal};

/// SQLite-backed journal store.
pub struct SqliteStore {
    connection: Connection,
}

impl SqliteStore {
    /// Opens a SQLite database and initializes the current journal schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path).map_err(backend)?;
        Self::from_connection(connection)
    }

    /// Initializes a caller-owned SQLite connection.
    pub fn from_connection(connection: Connection) -> Result<Self, StoreError> {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS nanocodex_journals (
                   journal_id TEXT PRIMARY KEY,
                   revision INTEGER NOT NULL CHECK (revision >= 0)
                 );
                 CREATE TABLE IF NOT EXISTS nanocodex_journal_batches (
                   journal_id TEXT NOT NULL,
                   revision INTEGER NOT NULL CHECK (revision > 0),
                   payload TEXT NOT NULL,
                   PRIMARY KEY (journal_id, revision),
                   FOREIGN KEY (journal_id) REFERENCES nanocodex_journals(journal_id)
                 );",
            )
            .map_err(backend)?;
        Ok(Self { connection })
    }
}

impl JournalStore for SqliteStore {
    fn load<'a>(
        &'a mut self,
        journal_id: &'a str,
    ) -> StoreFuture<'a, Result<StoredJournal, StoreError>> {
        let result = (|| {
            let connection = &self.connection;
            let revision = connection
                .query_row(
                    "SELECT revision FROM nanocodex_journals WHERE journal_id = ?1",
                    [journal_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(backend)?
                .unwrap_or(0);
            let revision = to_u64(revision)?;
            let mut statement = connection
                .prepare(
                    "SELECT revision, payload FROM nanocodex_journal_batches
                     WHERE journal_id = ?1 ORDER BY revision",
                )
                .map_err(backend)?;
            let batches = statement
                .query_map([journal_id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(backend)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(backend)?
                .into_iter()
                .map(|(revision, payload)| {
                    Ok(StoredBatch {
                        revision: to_u64(revision)?,
                        payload,
                    })
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            Ok(StoredJournal { revision, batches })
        })();
        Box::pin(async move { result })
    }

    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        let result = (|| {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(backend)?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO nanocodex_journals (journal_id, revision) VALUES (?1, 0)",
                    [journal_id],
                )
                .map_err(backend)?;
            let actual = transaction
                .query_row(
                    "SELECT revision FROM nanocodex_journals WHERE journal_id = ?1",
                    [journal_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(backend)?;
            let actual = to_u64(actual)?;
            if actual != expected_revision {
                return Err(StoreError::Conflict {
                    expected: expected_revision,
                    actual,
                });
            }
            let revision = actual.saturating_add(1);
            let sql_revision =
                i64::try_from(revision).map_err(|error| StoreError::Backend(error.to_string()))?;
            transaction
                .execute(
                    "INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
                     VALUES (?1, ?2, ?3)",
                    params![journal_id, sql_revision, payload],
                )
                .map_err(backend)?;
            transaction
                .execute(
                    "UPDATE nanocodex_journals SET revision = ?2 WHERE journal_id = ?1",
                    params![journal_id, sql_revision],
                )
                .map_err(backend)?;
            transaction.commit().map_err(backend)?;
            Ok(revision)
        })();
        Box::pin(async move { result })
    }
}

fn backend(error: rusqlite::Error) -> StoreError {
    StoreError::Backend(error.to_string())
}

fn to_u64(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|error| StoreError::Backend(error.to_string()))
}
