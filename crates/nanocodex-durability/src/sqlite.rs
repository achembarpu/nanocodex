use std::path::Path;

use rusqlite::{Connection, OptionalExtension as _, TransactionBehavior, params};

use crate::{
    JournalStore, OwnedJournal, OwnerId, OwnerToken, StoreError, StoreFuture, StoredBatch,
    StoredJournal,
};

// SQLite INTEGER revisions deliberately stop at the signed 64-bit SQL ceiling.
// Owner fences use a textual encoding so the public u64 token remains lossless.
const MAX_SQL_REVISION: u64 = i64::MAX as u64;

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
                 );
                 CREATE TABLE IF NOT EXISTS nanocodex_journal_owners (
                   journal_id TEXT PRIMARY KEY,
                   owner_id TEXT NOT NULL,
                   fence TEXT NOT NULL
                 );",
            )
            .map_err(backend)?;
        validate_owner_schema(&connection)?;
        Ok(Self { connection })
    }

    fn acquire_owner_transactional(
        &mut self,
        journal_id: &str,
        owner_id: OwnerId,
        after_begin: impl FnOnce(),
    ) -> Result<OwnedJournal, StoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(backend)?;
        after_begin();
        let retained_fence = transaction
            .query_row(
                "SELECT fence FROM nanocodex_journal_owners WHERE journal_id = ?1",
                [journal_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(backend)?;
        let fence = match retained_fence {
            Some(retained) => {
                let retained = parse_u64(&retained, "SQLite owner fence")?;
                retained.checked_add(1).ok_or_else(|| {
                    StoreError::NotCommitted("SQLite durability owner fence overflow".to_owned())
                })?
            }
            None => 1,
        };
        transaction
            .execute(
                "INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT (journal_id) DO UPDATE
                 SET owner_id = excluded.owner_id, fence = excluded.fence",
                params![journal_id, owner_id.as_str(), fence.to_string()],
            )
            .map_err(backend)?;
        let journal = load_journal(&transaction, journal_id)?;
        let owner = OwnerToken::new(owner_id, fence);
        transaction.commit().map_err(backend)?;
        Ok(OwnedJournal { owner, journal })
    }

    fn append_transactional(
        &mut self,
        journal_id: &str,
        owner: &OwnerToken,
        expected_revision: u64,
        payload: &str,
        after_begin: impl FnOnce(),
    ) -> Result<u64, StoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(backend)?;
        after_begin();
        let retained_owner = transaction
            .query_row(
                "SELECT owner_id, fence FROM nanocodex_journal_owners WHERE journal_id = ?1",
                [journal_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(backend)?;
        let owns_journal = match retained_owner {
            Some((owner_id, fence)) => {
                owner_id == owner.owner_id().as_str()
                    && parse_u64(&fence, "SQLite owner fence")? == owner.fence()
            }
            None => false,
        };
        if !owns_journal {
            return Err(StoreError::Fenced);
        }
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
        let revision = actual.checked_add(1).ok_or_else(|| {
            StoreError::NotCommitted("SQLite durability revision overflow".to_owned())
        })?;
        let sql_revision = sql_counter(revision, "SQLite durability revision overflow")?;
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
    }
}

impl JournalStore for SqliteStore {
    fn acquire_owner<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedJournal, StoreError>> {
        let result = self.acquire_owner_transactional(journal_id, owner_id, || {});
        Box::pin(async move { result })
    }

    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner: &'a OwnerToken,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        let result =
            self.append_transactional(journal_id, owner, expected_revision, payload, || {});
        Box::pin(async move { result })
    }
}

fn validate_owner_schema(connection: &Connection) -> Result<(), StoreError> {
    let mut statement = connection
        .prepare("PRAGMA table_info('nanocodex_journal_owners')")
        .map_err(backend)?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(backend)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(backend)?;
    let expected = [
        ("journal_id", "TEXT", false, 1),
        ("owner_id", "TEXT", true, 0),
        ("fence", "TEXT", true, 0),
    ];
    for (name, declared_type, not_null, primary_key) in expected {
        let Some((_, actual_type, actual_not_null, actual_primary_key)) =
            columns.iter().find(|(actual_name, ..)| actual_name == name)
        else {
            return Err(incompatible_owner_schema(format!(
                "missing required `{name}` column"
            )));
        };
        if !actual_type.eq_ignore_ascii_case(declared_type) {
            return Err(incompatible_owner_schema(format!(
                "`{name}` must be declared {declared_type}, found {actual_type}"
            )));
        }
        if not_null && !actual_not_null {
            return Err(incompatible_owner_schema(format!(
                "`{name}` has an incompatible NOT NULL constraint"
            )));
        }
        if *actual_primary_key != primary_key {
            return Err(incompatible_owner_schema(format!(
                "`{name}` has an incompatible PRIMARY KEY constraint"
            )));
        }
    }
    if columns
        .iter()
        .any(|(name, _, _, primary_key)| name != "journal_id" && *primary_key != 0)
    {
        return Err(incompatible_owner_schema(
            "the PRIMARY KEY must contain only `journal_id`".to_owned(),
        ));
    }
    Ok(())
}

fn incompatible_owner_schema(detail: String) -> StoreError {
    StoreError::Backend(format!(
        "incompatible SQLite `nanocodex_journal_owners` schema: {detail}; recreate the table with the current schema"
    ))
}

fn load_journal(connection: &Connection, journal_id: &str) -> Result<StoredJournal, StoreError> {
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
}

fn backend(error: rusqlite::Error) -> StoreError {
    StoreError::Backend(error.to_string())
}

fn to_u64(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|error| StoreError::Backend(error.to_string()))
}

fn parse_u64(value: &str, label: &str) -> Result<u64, StoreError> {
    value
        .parse()
        .map_err(|error| StoreError::Backend(format!("invalid {label}: {error}")))
}

fn sql_counter(value: u64, overflow: &str) -> Result<i64, StoreError> {
    debug_assert_eq!(MAX_SQL_REVISION, i64::MAX as u64);
    i64::try_from(value).map_err(|_| StoreError::NotCommitted(overflow.to_owned()))
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::mpsc, thread, time::Duration};

    use super::*;

    fn open_concurrent_store(path: &Path) -> SqliteStore {
        let connection = Connection::open(path).unwrap();
        connection.busy_timeout(Duration::from_secs(2)).unwrap();
        SqliteStore::from_connection(connection).unwrap()
    }

    fn retained_owner(path: &Path) -> (String, String) {
        Connection::open(path)
            .unwrap()
            .query_row(
                "SELECT owner_id, fence FROM nanocodex_journal_owners WHERE journal_id = 'journal'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    fn retained_journal(path: &Path) -> StoredJournal {
        load_journal(&Connection::open(path).unwrap(), "journal").unwrap()
    }

    fn assert_contender_waits<T>(started: mpsc::Receiver<()>, handle: &thread::JoinHandle<T>) {
        started.recv().unwrap();
        thread::sleep(Duration::from_millis(20));
        assert!(
            !handle.is_finished(),
            "the contender completed while the first write transaction still held the lock"
        );
    }

    fn assert_schema_error(create_owners: &str, expected_detail: &str) {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(create_owners).unwrap();
        let error = match SqliteStore::from_connection(connection) {
            Ok(_) => panic!("incompatible ownership schema was accepted"),
            Err(error) => error,
        };
        let message = error.to_string();
        assert!(message.contains("incompatible SQLite `nanocodex_journal_owners` schema"));
        assert!(
            message.contains(expected_detail),
            "unexpected error: {message}"
        );
    }

    #[test]
    fn initialization_rejects_malformed_preexisting_owner_tables() {
        assert_schema_error(
            "CREATE TABLE nanocodex_journal_owners (journal_id TEXT PRIMARY KEY)",
            "missing required `owner_id` column",
        );
        assert_schema_error(
            "CREATE TABLE nanocodex_journal_owners (
               journal_id TEXT PRIMARY KEY,
               owner_id TEXT NOT NULL,
               fence INTEGER NOT NULL
             )",
            "`fence` must be declared TEXT",
        );
        assert_schema_error(
            "CREATE TABLE nanocodex_journal_owners (
               journal_id TEXT,
               owner_id TEXT NOT NULL,
               fence TEXT NOT NULL
             )",
            "`journal_id` has an incompatible PRIMARY KEY constraint",
        );
        assert_schema_error(
            "CREATE TABLE nanocodex_journal_owners (
               journal_id TEXT PRIMARY KEY,
               owner_id TEXT,
               fence TEXT NOT NULL
             )",
            "`owner_id` has an incompatible NOT NULL constraint",
        );
        assert_schema_error(
            "CREATE TABLE nanocodex_journal_owners (
               journal_id TEXT PRIMARY KEY,
               owner_id TEXT NOT NULL,
               fence TEXT
             )",
            "`fence` has an incompatible NOT NULL constraint",
        );
    }

    #[test]
    fn concurrent_acquires_serialize_and_install_the_last_owner() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_owned();
        let first_owner = OwnerId::new();
        let second_owner = OwnerId::new();
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mut first_store = open_concurrent_store(&path);
        let mut second_store = open_concurrent_store(&path);
        let first_id = first_owner;
        let first = thread::spawn(move || {
            first_store.acquire_owner_transactional("journal", first_id, || {
                locked_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        });
        locked_rx.recv().unwrap();

        let (started_tx, started_rx) = mpsc::channel();
        let second_id = second_owner.clone();
        let second = thread::spawn(move || {
            started_tx.send(()).unwrap();
            second_store.acquire_owner_transactional("journal", second_id, || {})
        });
        assert_contender_waits(started_rx, &second);
        release_tx.send(()).unwrap();

        let first = first.join().unwrap().unwrap();
        let second = second.join().unwrap().unwrap();
        assert_eq!(first.owner.fence(), 1);
        assert_eq!(second.owner.fence(), 2);
        assert_eq!(
            retained_owner(&path),
            (second_owner.as_str().to_owned(), "2".to_owned())
        );
        assert_eq!(retained_journal(&path), StoredJournal::default());

        let mut stale = open_concurrent_store(&path);
        assert_eq!(
            stale.append_transactional("journal", &first.owner, 0, "stale", || {}),
            Err(StoreError::Fenced)
        );
    }

    #[test]
    fn acquire_then_stale_append_is_fenced_before_revision_comparison() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_owned();
        let mut seeded = open_concurrent_store(&path);
        let old = seeded
            .acquire_owner_transactional("journal", OwnerId::new(), || {})
            .unwrap();
        drop(seeded);

        let new_owner = OwnerId::new();
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mut acquire_store = open_concurrent_store(&path);
        let mut append_store = open_concurrent_store(&path);
        let acquire_id = new_owner.clone();
        let acquire = thread::spawn(move || {
            acquire_store.acquire_owner_transactional("journal", acquire_id, || {
                locked_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        });
        locked_rx.recv().unwrap();

        let (started_tx, started_rx) = mpsc::channel();
        let old_owner = old.owner;
        let append = thread::spawn(move || {
            started_tx.send(()).unwrap();
            append_store.append_transactional("journal", &old_owner, 99, "stale", || {})
        });
        assert_contender_waits(started_rx, &append);
        release_tx.send(()).unwrap();

        let acquired = acquire.join().unwrap().unwrap();
        assert_eq!(append.join().unwrap(), Err(StoreError::Fenced));
        assert_eq!(acquired.owner.fence(), 2);
        assert_eq!(
            retained_owner(&path),
            (new_owner.as_str().to_owned(), "2".to_owned())
        );
        assert_eq!(retained_journal(&path), StoredJournal::default());
    }

    #[test]
    fn append_then_acquire_commits_before_fencing_the_writer() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_owned();
        let mut seeded = open_concurrent_store(&path);
        let old = seeded
            .acquire_owner_transactional("journal", OwnerId::new(), || {})
            .unwrap();
        drop(seeded);

        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mut append_store = open_concurrent_store(&path);
        let mut acquire_store = open_concurrent_store(&path);
        let old_owner = old.owner.clone();
        let append = thread::spawn(move || {
            append_store.append_transactional("journal", &old_owner, 0, "committed", || {
                locked_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        });
        locked_rx.recv().unwrap();

        let new_owner = OwnerId::new();
        let (started_tx, started_rx) = mpsc::channel();
        let acquire_id = new_owner.clone();
        let acquire = thread::spawn(move || {
            started_tx.send(()).unwrap();
            acquire_store.acquire_owner_transactional("journal", acquire_id, || {})
        });
        assert_contender_waits(started_rx, &acquire);
        release_tx.send(()).unwrap();

        assert_eq!(append.join().unwrap(), Ok(1));
        let acquired = acquire.join().unwrap().unwrap();
        assert_eq!(acquired.owner.fence(), 2);
        assert_eq!(acquired.journal.revision, 1);
        assert_eq!(acquired.journal.batches[0].payload, "committed");
        assert_eq!(
            retained_owner(&path),
            (new_owner.as_str().to_owned(), "2".to_owned())
        );
        assert_eq!(retained_journal(&path), acquired.journal);

        let mut stale = open_concurrent_store(&path);
        assert_eq!(
            stale.append_transactional("journal", &old.owner, 999, "stale", || {}),
            Err(StoreError::Fenced)
        );
    }

    #[test]
    fn concurrent_same_revision_appends_commit_exactly_one_batch() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_owned();
        let mut seeded = open_concurrent_store(&path);
        let owned = seeded
            .acquire_owner_transactional("journal", OwnerId::new(), || {})
            .unwrap();
        drop(seeded);

        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mut first_store = open_concurrent_store(&path);
        let mut second_store = open_concurrent_store(&path);
        let first_owner = owned.owner.clone();
        let first = thread::spawn(move || {
            first_store.append_transactional("journal", &first_owner, 0, "first", || {
                locked_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        });
        locked_rx.recv().unwrap();

        let (started_tx, started_rx) = mpsc::channel();
        let second_owner = owned.owner.clone();
        let second = thread::spawn(move || {
            started_tx.send(()).unwrap();
            second_store.append_transactional("journal", &second_owner, 0, "second", || {})
        });
        assert_contender_waits(started_rx, &second);
        release_tx.send(()).unwrap();

        assert_eq!(first.join().unwrap(), Ok(1));
        assert_eq!(
            second.join().unwrap(),
            Err(StoreError::Conflict {
                expected: 0,
                actual: 1,
            })
        );
        assert_eq!(
            retained_owner(&path),
            (owned.owner.owner_id().as_str().to_owned(), "1".to_owned())
        );
        assert_eq!(
            retained_journal(&path),
            StoredJournal {
                revision: 1,
                batches: vec![StoredBatch {
                    revision: 1,
                    payload: "first".to_owned(),
                }],
            }
        );
    }

    #[tokio::test]
    async fn reopen_fences_stale_owner_and_preserves_legacy_batches() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let connection = Connection::open(file.path()).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE nanocodex_journals (
                   journal_id TEXT PRIMARY KEY,
                   revision INTEGER NOT NULL CHECK (revision >= 0)
                 );
                 CREATE TABLE nanocodex_journal_batches (
                   journal_id TEXT NOT NULL,
                   revision INTEGER NOT NULL CHECK (revision > 0),
                   payload TEXT NOT NULL,
                   PRIMARY KEY (journal_id, revision),
                   FOREIGN KEY (journal_id) REFERENCES nanocodex_journals(journal_id)
                 );
                 INSERT INTO nanocodex_journals VALUES ('journal', 1);
                 INSERT INTO nanocodex_journal_batches VALUES ('journal', 1, 'legacy');",
            )
            .unwrap();
        let mut first = SqliteStore::from_connection(connection).unwrap();
        let first_owned = first
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        assert_eq!(first_owned.owner.fence(), 1);
        assert_eq!(first_owned.journal.batches[0].payload, "legacy");
        drop(first);

        let mut second = SqliteStore::open(file.path()).unwrap();
        let second_owned = second
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        assert_eq!(second_owned.owner.fence(), 2);
        assert_eq!(
            second
                .append("journal", &first_owned.owner, 0, "stale")
                .await,
            Err(StoreError::Fenced)
        );
    }

    #[tokio::test]
    async fn authority_survives_without_journal_content() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut store = SqliteStore::open(file.path()).unwrap();
        let first = store
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        store
            .append("journal", &first.owner, 0, "content")
            .await
            .unwrap();
        drop(store);

        let connection = Connection::open(file.path()).unwrap();
        connection
            .execute("DELETE FROM nanocodex_journal_batches", [])
            .unwrap();
        connection
            .execute("DELETE FROM nanocodex_journals", [])
            .unwrap();
        drop(connection);

        let mut reopened = SqliteStore::open(file.path()).unwrap();
        let acquired = reopened
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        assert_eq!(acquired.owner.fence(), 2);
        assert_eq!(acquired.journal, StoredJournal::default());
    }

    #[tokio::test]
    async fn owner_fence_overflow_is_not_committed() {
        let mut store =
            SqliteStore::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let prior_owner = OwnerId::new();
        store
            .connection
            .execute(
                "INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
                 VALUES (?1, ?2, ?3)",
                params!["journal", prior_owner.as_str(), (u64::MAX - 1).to_string()],
            )
            .unwrap();

        let installed_owner = OwnerId::new();
        let installed = store
            .acquire_owner("journal", installed_owner.clone())
            .await
            .unwrap();
        assert_eq!(installed.owner.fence(), u64::MAX);
        assert!(matches!(
            store.acquire_owner("journal", OwnerId::new()).await,
            Err(StoreError::NotCommitted(_))
        ));
        let retained = store
            .connection
            .query_row(
                "SELECT owner_id, fence FROM nanocodex_journal_owners WHERE journal_id = ?1",
                ["journal"],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(
            retained,
            (installed_owner.as_str().to_owned(), u64::MAX.to_string())
        );
    }

    #[tokio::test]
    async fn revision_above_signed_64_bit_ceiling_is_not_committed() {
        let mut store =
            SqliteStore::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let owned = store
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO nanocodex_journals (journal_id, revision) VALUES (?1, ?2)",
                params!["journal", i64::MAX],
            )
            .unwrap();

        assert!(matches!(
            store
                .append("journal", &owned.owner, MAX_SQL_REVISION, "overflow")
                .await,
            Err(StoreError::NotCommitted(message))
                if message == "SQLite durability revision overflow"
        ));
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT revision FROM nanocodex_journals WHERE journal_id = 'journal'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            i64::MAX
        );
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT count(*) FROM nanocodex_journal_batches",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            0
        );
    }
}
