use tokio_postgres::{Client, Transaction, error::SqlState, types::ToSql};

use crate::{
    JournalStore, OwnedJournal, OwnerId, OwnerToken, StoreError, StoreFuture, StoredBatch,
    StoredJournal,
};

// The shared Postgres schema retains the complete u64 range for JavaScript
// adapters. Native revisions deliberately stop at the signed 64-bit ceiling.
const MAX_NATIVE_REVISION: u64 = i64::MAX as u64;
const MAX_U64_DECIMAL: &str = "18446744073709551615";
const ABOVE_MAX_U64_DECIMAL: &str = "18446744073709551616";

const POSTGRES_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS nanocodex_journals (
       journal_id TEXT PRIMARY KEY,
       revision NUMERIC(20, 0) NOT NULL
         CHECK (revision >= 0 AND revision <= 18446744073709551615)
     );
     CREATE TABLE IF NOT EXISTS nanocodex_journal_batches (
       journal_id TEXT NOT NULL REFERENCES nanocodex_journals(journal_id),
       revision NUMERIC(20, 0) NOT NULL
         CHECK (revision > 0 AND revision <= 18446744073709551615),
       payload TEXT NOT NULL,
       PRIMARY KEY (journal_id, revision)
     );
     CREATE TABLE IF NOT EXISTS nanocodex_journal_owners (
       journal_id TEXT PRIMARY KEY,
       owner_id TEXT NOT NULL,
       fence NUMERIC(20, 0) NOT NULL
         CHECK (fence >= 1 AND fence <= 18446744073709551615)
     );";

/// Postgres-backed journal store.
pub struct PostgresStore {
    client: Client,
}

impl PostgresStore {
    /// Initializes the current journal schema using a caller-driven Postgres client.
    pub async fn new(client: Client) -> Result<Self, StoreError> {
        let mut store = Self { client };
        let transaction = store.client.transaction().await.map_err(backend)?;
        transaction
            .query(
                "SELECT pg_advisory_xact_lock(hashtextextended(
                   current_database() || ':' || current_schema() || ':nanocodex-durability', 0
                 ))",
                &[],
            )
            .await
            .map_err(backend)?;
        upgrade_released_schema(&transaction).await?;
        transaction
            .batch_execute(POSTGRES_SCHEMA)
            .await
            .map_err(backend)?;
        validate_schema(&transaction).await?;
        transaction.commit().await.map_err(backend)?;
        Ok(store)
    }
}

impl JournalStore for PostgresStore {
    fn acquire_owner<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedJournal, StoreError>> {
        Box::pin(async move {
            let transaction = self.client.transaction().await.map_err(backend)?;
            let row = transaction
                .query_opt(
                    "INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
                     VALUES ($1, $2, 1)
                     ON CONFLICT (journal_id) DO UPDATE
                     SET owner_id = excluded.owner_id,
                         fence = nanocodex_journal_owners.fence + 1
                     WHERE nanocodex_journal_owners.fence < 18446744073709551615
                     RETURNING fence::text",
                    &[&journal_id, &owner_id.as_str()],
                )
                .await
                .map_err(backend)?
                .ok_or_else(|| {
                    StoreError::NotCommitted("Postgres durability owner fence overflow".to_owned())
                })?;
            let fence = parse_u64(&row.get::<_, String>(0), "Postgres owner fence")?;
            let revision = transaction
                .query_opt(
                    "SELECT revision::text FROM nanocodex_journals WHERE journal_id = $1",
                    &[&journal_id],
                )
                .await
                .map_err(backend)?
                .map_or_else(
                    || Ok(0),
                    |row| parse_u64(&row.get::<_, String>(0), "Postgres journal revision"),
                )?;
            let rows = transaction
                .query(
                    "SELECT revision::text, payload FROM nanocodex_journal_batches
                     WHERE journal_id = $1 ORDER BY revision",
                    &[&journal_id],
                )
                .await
                .map_err(backend)?;
            let batches = rows
                .into_iter()
                .map(|row| {
                    let revision = row.get::<_, String>(0);
                    Ok(StoredBatch {
                        revision: parse_u64(&revision, "Postgres batch revision")?,
                        payload: row.get(1),
                    })
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            let journal = StoredJournal { revision, batches };
            let owner = OwnerToken::new(owner_id, fence);
            transaction.commit().await.map_err(backend)?;
            Ok(OwnedJournal { owner, journal })
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
            let transaction = self.client.transaction().await.map_err(backend)?;
            let retained_owner = transaction
                .query_opt(
                    "SELECT owner_id, fence::text FROM nanocodex_journal_owners
                     WHERE journal_id = $1 FOR UPDATE",
                    &[&journal_id],
                )
                .await
                .map_err(backend)?;
            let owns_journal = match retained_owner {
                Some(row) => {
                    let owner_id = row.get::<_, String>(0);
                    let fence = row.get::<_, String>(1);
                    owner_id == owner.owner_id().as_str()
                        && parse_u64(&fence, "Postgres owner fence")? == owner.fence()
                }
                None => false,
            };
            if !owns_journal {
                return Err(StoreError::Fenced);
            }
            transaction
                .execute(
                    "INSERT INTO nanocodex_journals (journal_id, revision) VALUES ($1, 0)
                     ON CONFLICT (journal_id) DO NOTHING",
                    &[&journal_id],
                )
                .await
                .map_err(backend)?;
            let actual = transaction
                .query_one(
                    "SELECT revision::text FROM nanocodex_journals
                     WHERE journal_id = $1 FOR UPDATE",
                    &[&journal_id],
                )
                .await
                .map_err(backend)?
                .get::<_, String>(0);
            let actual = parse_u64(&actual, "Postgres journal revision")?;
            if actual != expected_revision {
                return Err(StoreError::Conflict {
                    expected: expected_revision,
                    actual,
                });
            }
            let revision = actual.checked_add(1).ok_or_else(|| {
                StoreError::NotCommitted("Postgres durability revision overflow".to_owned())
            })?;
            let native_revision = native_revision(revision)?;
            transaction
                .execute(
                    "INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
                     VALUES ($1, $2::bigint, $3)",
                    &[&journal_id, &native_revision, &payload],
                )
                .await
                .map_err(backend)?;
            transaction
                .execute(
                    "UPDATE nanocodex_journals SET revision = $2::bigint WHERE journal_id = $1",
                    &[&journal_id, &native_revision],
                )
                .await
                .map_err(backend)?;
            transaction.commit().await.map_err(backend)?;
            Ok(revision)
        })
    }
}

fn backend(error: tokio_postgres::Error) -> StoreError {
    StoreError::Backend(error.to_string())
}

#[derive(Clone, Copy)]
struct ColumnSpec {
    name: &'static str,
    type_name: &'static str,
    not_null: bool,
    numeric_shape: Option<(i32, i32)>,
}

const fn text_not_null(name: &'static str) -> ColumnSpec {
    ColumnSpec {
        name,
        type_name: "text",
        not_null: true,
        numeric_shape: None,
    }
}

const fn u64_numeric(name: &'static str) -> ColumnSpec {
    ColumnSpec {
        name,
        type_name: "numeric",
        not_null: true,
        numeric_shape: Some((20, 0)),
    }
}

const fn released_bigint(name: &'static str) -> ColumnSpec {
    ColumnSpec {
        name,
        type_name: "int8",
        not_null: true,
        numeric_shape: None,
    }
}

async fn upgrade_released_schema(transaction: &Transaction<'_>) -> Result<(), StoreError> {
    if !is_released_schema(transaction).await? {
        return Ok(());
    }

    transaction
        .batch_execute(
            "ALTER TABLE nanocodex_journals
               DROP CONSTRAINT nanocodex_journals_revision_check;
             ALTER TABLE nanocodex_journal_batches
               DROP CONSTRAINT nanocodex_journal_batches_revision_check;
             ALTER TABLE nanocodex_journals
               ALTER COLUMN revision TYPE NUMERIC(20, 0) USING revision::numeric;
             ALTER TABLE nanocodex_journal_batches
               ALTER COLUMN revision TYPE NUMERIC(20, 0) USING revision::numeric;
             ALTER TABLE nanocodex_journals
               ADD CONSTRAINT nanocodex_journals_revision_check
               CHECK (revision >= 0 AND revision <= 18446744073709551615);
             ALTER TABLE nanocodex_journal_batches
               ADD CONSTRAINT nanocodex_journal_batches_revision_check
               CHECK (revision > 0 AND revision <= 18446744073709551615);",
        )
        .await
        .map_err(backend)
}

async fn is_released_schema(transaction: &Transaction<'_>) -> Result<bool, StoreError> {
    let relations = transaction
        .query_one(
            "SELECT to_regclass('nanocodex_journals') IS NOT NULL,
                    to_regclass('nanocodex_journal_batches') IS NOT NULL,
                    to_regclass('nanocodex_journal_owners') IS NOT NULL",
            &[],
        )
        .await
        .map_err(backend)?;
    if !relations.get::<_, bool>(0) || !relations.get::<_, bool>(1) {
        return Ok(false);
    }
    let owners_exist = relations.get::<_, bool>(2);
    if !table_matches(
        transaction,
        "nanocodex_journals",
        &[text_not_null("journal_id"), released_bigint("revision")],
        &["journal_id"],
    )
    .await?
        || !table_matches(
            transaction,
            "nanocodex_journal_batches",
            &[
                text_not_null("journal_id"),
                released_bigint("revision"),
                text_not_null("payload"),
            ],
            &["journal_id", "revision"],
        )
        .await?
        || !has_canonical_foreign_key(&foreign_keys(transaction).await?)
    {
        return Ok(false);
    }

    let checks = check_specs(transaction).await?;
    let checks_match = checks
        == if owners_exist {
            vec![
                CheckSpec {
                    table: "nanocodex_journal_batches".to_owned(),
                    column: Some("revision".to_owned()),
                },
                CheckSpec {
                    table: "nanocodex_journal_owners".to_owned(),
                    column: Some("fence".to_owned()),
                },
                CheckSpec {
                    table: "nanocodex_journals".to_owned(),
                    column: Some("revision".to_owned()),
                },
            ]
        } else {
            vec![
                CheckSpec {
                    table: "nanocodex_journal_batches".to_owned(),
                    column: Some("revision".to_owned()),
                },
                CheckSpec {
                    table: "nanocodex_journals".to_owned(),
                    column: Some("revision".to_owned()),
                },
            ]
        };
    if !checks_match || (owners_exist && !is_current_empty_owner_table(transaction).await?) {
        return Ok(false);
    }

    Ok(released_checks(transaction).await?
        == [
            ReleasedCheck {
                table: "nanocodex_journal_batches".to_owned(),
                name: "nanocodex_journal_batches_revision_check".to_owned(),
                expression: "revision>0".to_owned(),
            },
            ReleasedCheck {
                table: "nanocodex_journals".to_owned(),
                name: "nanocodex_journals_revision_check".to_owned(),
                expression: "revision>=0".to_owned(),
            },
        ])
}

async fn is_current_empty_owner_table(transaction: &Transaction<'_>) -> Result<bool, StoreError> {
    if !table_matches(
        transaction,
        "nanocodex_journal_owners",
        &[
            text_not_null("journal_id"),
            text_not_null("owner_id"),
            u64_numeric("fence"),
        ],
        &["journal_id"],
    )
    .await?
        || transaction
            .query_one(
                "SELECT EXISTS (SELECT 1 FROM nanocodex_journal_owners)",
                &[],
            )
            .await
            .map_err(backend)?
            .get::<_, bool>(0)
    {
        return Ok(false);
    }

    let probe = uuid::Uuid::now_v7().simple().to_string();
    transaction
        .batch_execute("SAVEPOINT nanocodex_owner_schema_boundaries")
        .await
        .map_err(backend)?;
    let validation = validate_owner_numeric_boundaries(transaction, &probe).await;
    transaction
        .batch_execute(
            "ROLLBACK TO SAVEPOINT nanocodex_owner_schema_boundaries;
             RELEASE SAVEPOINT nanocodex_owner_schema_boundaries",
        )
        .await
        .map_err(backend)?;
    Ok(validation.is_ok())
}

#[derive(Debug, PartialEq, Eq)]
struct ReleasedCheck {
    table: String,
    name: String,
    expression: String,
}

async fn released_checks(transaction: &Transaction<'_>) -> Result<Vec<ReleasedCheck>, StoreError> {
    transaction
        .query(
            "SELECT retained_table.relname, retained_constraint.conname,
                    pg_get_expr(retained_constraint.conbin, retained_constraint.conrelid)
             FROM pg_constraint AS retained_constraint
             JOIN pg_class AS retained_table
               ON retained_table.oid = retained_constraint.conrelid
             JOIN pg_namespace AS retained_schema
               ON retained_schema.oid = retained_table.relnamespace
             WHERE retained_schema.nspname = current_schema()
               AND retained_table.relname IN (
                 'nanocodex_journals',
                 'nanocodex_journal_batches'
               )
               AND retained_constraint.contype = 'c'
               AND retained_constraint.convalidated
               AND NOT retained_constraint.connoinherit
             ORDER BY retained_table.relname, retained_constraint.oid",
            &[],
        )
        .await
        .map_err(backend)
        .map(|rows| {
            rows.into_iter()
                .map(|row| ReleasedCheck {
                    table: row.get(0),
                    name: row.get(1),
                    expression: normalize_check_expression(&row.get::<_, String>(2)),
                })
                .collect()
        })
}

fn normalize_check_expression(expression: &str) -> String {
    expression
        .chars()
        .filter(|character| !character.is_ascii_whitespace() && !matches!(character, '(' | ')'))
        .collect::<String>()
}

async fn validate_schema(transaction: &Transaction<'_>) -> Result<(), StoreError> {
    validate_table(
        transaction,
        "nanocodex_journals",
        &[text_not_null("journal_id"), u64_numeric("revision")],
        &["journal_id"],
    )
    .await?;
    validate_table(
        transaction,
        "nanocodex_journal_batches",
        &[
            text_not_null("journal_id"),
            u64_numeric("revision"),
            text_not_null("payload"),
        ],
        &["journal_id", "revision"],
    )
    .await?;
    validate_table(
        transaction,
        "nanocodex_journal_owners",
        &[
            text_not_null("journal_id"),
            text_not_null("owner_id"),
            u64_numeric("fence"),
        ],
        &["journal_id"],
    )
    .await?;
    validate_foreign_keys(transaction).await?;
    validate_numeric_checks(transaction).await
}

async fn validate_table(
    transaction: &Transaction<'_>,
    table: &str,
    expected_columns: &[ColumnSpec],
    expected_primary_key: &[&str],
) -> Result<(), StoreError> {
    let columns = table_columns(transaction, table).await?;
    if columns.len() != expected_columns.len() {
        return Err(incompatible_schema(format!(
            "`{table}` must contain exactly {} columns, found {}",
            expected_columns.len(),
            columns.len()
        )));
    }
    for (actual, expected) in columns.iter().zip(expected_columns) {
        if actual.name != expected.name
            || actual.type_name != expected.type_name
            || actual.not_null != expected.not_null
            || actual.numeric_shape != expected.numeric_shape
        {
            return Err(incompatible_schema(format!(
                "`{table}.{}` has an incompatible column shape",
                expected.name
            )));
        }
    }
    if table_primary_key(transaction, table).await? != expected_primary_key {
        return Err(incompatible_schema(format!(
            "`{table}` has an incompatible PRIMARY KEY"
        )));
    }
    Ok(())
}

struct ColumnShape {
    name: String,
    type_name: String,
    not_null: bool,
    numeric_shape: Option<(i32, i32)>,
}

async fn table_matches(
    transaction: &Transaction<'_>,
    table: &str,
    expected_columns: &[ColumnSpec],
    expected_primary_key: &[&str],
) -> Result<bool, StoreError> {
    let columns = table_columns(transaction, table).await?;
    if columns.len() != expected_columns.len() {
        return Ok(false);
    }
    if columns
        .iter()
        .zip(expected_columns)
        .any(|(actual, expected)| {
            actual.name != expected.name
                || actual.type_name != expected.type_name
                || actual.not_null != expected.not_null
                || actual.numeric_shape != expected.numeric_shape
        })
    {
        return Ok(false);
    }
    Ok(table_primary_key(transaction, table).await? == expected_primary_key)
}

async fn table_columns(
    transaction: &Transaction<'_>,
    table: &str,
) -> Result<Vec<ColumnShape>, StoreError> {
    transaction
        .query(
            "SELECT attribute.attname, type.typname, attribute.attnotnull,
                    CASE WHEN type.typname = 'numeric' AND attribute.atttypmod >= 0
                         THEN ((attribute.atttypmod - 4) >> 16) & 65535 END,
                    CASE WHEN type.typname = 'numeric' AND attribute.atttypmod >= 0
                         THEN (attribute.atttypmod - 4) & 65535 END
             FROM pg_attribute AS attribute
             JOIN pg_type AS type ON type.oid = attribute.atttypid
             WHERE attribute.attrelid = $1::text::regclass
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped
             ORDER BY attribute.attnum",
            &[&table],
        )
        .await
        .map_err(backend)?
        .into_iter()
        .map(|row| {
            let numeric_shape = match (row.get(3), row.get(4)) {
                (Some(precision), Some(scale)) => Some((precision, scale)),
                (None, None) => None,
                _ => {
                    return Err(incompatible_schema(
                        "incomplete numeric metadata".to_owned(),
                    ));
                }
            };
            Ok(ColumnShape {
                name: row.get(0),
                type_name: row.get(1),
                not_null: row.get(2),
                numeric_shape,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()
}

async fn table_primary_key(
    transaction: &Transaction<'_>,
    table: &str,
) -> Result<Vec<String>, StoreError> {
    let primary_key = transaction
        .query(
            "SELECT attribute.attname
             FROM pg_index AS index
             CROSS JOIN LATERAL unnest(index.indkey)
               WITH ORDINALITY AS key(attnum, position)
             JOIN pg_attribute AS attribute
               ON attribute.attrelid = index.indrelid
              AND attribute.attnum = key.attnum
             WHERE index.indrelid = $1::text::regclass
               AND index.indisprimary
             ORDER BY key.position",
            &[&table],
        )
        .await
        .map_err(backend)?
        .into_iter()
        .map(|row| row.get::<_, String>(0))
        .collect::<Vec<_>>();
    Ok(primary_key)
}

async fn validate_foreign_keys(transaction: &Transaction<'_>) -> Result<(), StoreError> {
    let foreign_keys = foreign_keys(transaction).await?;
    if !has_canonical_foreign_key(&foreign_keys) {
        return Err(incompatible_schema(
            "`nanocodex_journal_batches` has an incompatible foreign key".to_owned(),
        ));
    }
    Ok(())
}

async fn foreign_keys(transaction: &Transaction<'_>) -> Result<Vec<ForeignKeySpec>, StoreError> {
    let rows = transaction
        .query(
            "SELECT source_attribute.attname,
                    target_schema.nspname = current_schema(),
                    target_table.relname, target_attribute.attname,
                    retained_constraint.condeferrable,
                    retained_constraint.condeferred
             FROM pg_constraint AS retained_constraint
             CROSS JOIN LATERAL unnest(retained_constraint.conkey, retained_constraint.confkey)
               WITH ORDINALITY AS key(source_attnum, target_attnum, position)
             JOIN pg_attribute AS source_attribute
               ON source_attribute.attrelid = retained_constraint.conrelid
              AND source_attribute.attnum = key.source_attnum
             JOIN pg_class AS target_table ON target_table.oid = retained_constraint.confrelid
             JOIN pg_namespace AS target_schema ON target_schema.oid = target_table.relnamespace
             JOIN pg_attribute AS target_attribute
               ON target_attribute.attrelid = retained_constraint.confrelid
              AND target_attribute.attnum = key.target_attnum
             WHERE retained_constraint.conrelid = 'nanocodex_journal_batches'::regclass
               AND retained_constraint.contype = 'f'
             ORDER BY retained_constraint.oid, key.position",
            &[],
        )
        .await
        .map_err(backend)?
        .into_iter()
        .map(|row| ForeignKeySpec {
            source_column: row.get(0),
            target_in_current_schema: row.get(1),
            target_table: row.get(2),
            target_column: row.get(3),
            deferrable: row.get(4),
            initially_deferred: row.get(5),
        })
        .collect::<Vec<_>>();
    Ok(rows)
}

#[derive(Debug, PartialEq, Eq)]
struct ForeignKeySpec {
    source_column: String,
    target_in_current_schema: bool,
    target_table: String,
    target_column: String,
    deferrable: bool,
    initially_deferred: bool,
}

fn has_canonical_foreign_key(foreign_keys: &[ForeignKeySpec]) -> bool {
    foreign_keys
        == [ForeignKeySpec {
            source_column: "journal_id".to_owned(),
            target_in_current_schema: true,
            target_table: "nanocodex_journals".to_owned(),
            target_column: "journal_id".to_owned(),
            deferrable: false,
            initially_deferred: false,
        }]
}

async fn check_specs(transaction: &Transaction<'_>) -> Result<Vec<CheckSpec>, StoreError> {
    let checks = transaction
        .query(
            "SELECT retained_table.relname, attribute.attname
             FROM pg_constraint AS retained_constraint
             JOIN pg_class AS retained_table
               ON retained_table.oid = retained_constraint.conrelid
             JOIN pg_namespace AS retained_schema
               ON retained_schema.oid = retained_table.relnamespace
             LEFT JOIN pg_attribute AS attribute
               ON attribute.attrelid = retained_constraint.conrelid
              AND retained_constraint.conkey = ARRAY[attribute.attnum]::smallint[]
             WHERE retained_schema.nspname = current_schema()
               AND retained_table.relname IN (
                 'nanocodex_journals',
                 'nanocodex_journal_batches',
                 'nanocodex_journal_owners'
               )
               AND retained_constraint.contype = 'c'
             ORDER BY retained_table.relname, retained_constraint.oid",
            &[],
        )
        .await
        .map_err(backend)?
        .into_iter()
        .map(|row| CheckSpec {
            table: row.get(0),
            column: row.get(1),
        })
        .collect::<Vec<_>>();
    Ok(checks)
}

async fn validate_numeric_checks(transaction: &Transaction<'_>) -> Result<(), StoreError> {
    let checks = check_specs(transaction).await?;
    for (table, column) in canonical_numeric_checks() {
        if !checks
            .iter()
            .any(|check| check.table == table && check.column.as_deref() == Some(column))
        {
            return Err(incompatible_schema(format!(
                "`{table}.{column}` must have a single-column CHECK constraint"
            )));
        }
    }
    if !has_canonical_numeric_checks(&checks) {
        return Err(incompatible_schema(
            "the journal tables have incompatible CHECK constraints".to_owned(),
        ));
    }

    let probe = uuid::Uuid::now_v7().simple().to_string();
    transaction
        .batch_execute("SAVEPOINT nanocodex_schema_boundaries")
        .await
        .map_err(backend)?;
    let validation = validate_numeric_boundaries(transaction, &probe).await;
    transaction
        .batch_execute(
            "ROLLBACK TO SAVEPOINT nanocodex_schema_boundaries;
             RELEASE SAVEPOINT nanocodex_schema_boundaries",
        )
        .await
        .map_err(backend)?;
    validation
}

#[derive(Debug, PartialEq, Eq)]
struct CheckSpec {
    table: String,
    column: Option<String>,
}

const fn canonical_numeric_checks() -> [(&'static str, &'static str); 3] {
    [
        ("nanocodex_journal_batches", "revision"),
        ("nanocodex_journal_owners", "fence"),
        ("nanocodex_journals", "revision"),
    ]
}

fn has_canonical_numeric_checks(checks: &[CheckSpec]) -> bool {
    checks.len() == canonical_numeric_checks().len()
        && checks
            .iter()
            .zip(canonical_numeric_checks())
            .all(|(actual, (table, column))| {
                actual.table == table && actual.column.as_deref() == Some(column)
            })
}

async fn validate_numeric_boundaries(
    transaction: &Transaction<'_>,
    probe: &str,
) -> Result<(), StoreError> {
    validate_owner_numeric_boundaries(transaction, probe).await?;
    for (suffix, revision) in [
        ("journal-min", "0"),
        ("journal-interior", "1"),
        ("journal-max", MAX_U64_DECIMAL),
    ] {
        transaction
            .execute(
                "INSERT INTO nanocodex_journals (journal_id, revision)
                 VALUES ($1, $2::text::numeric)",
                &[&format!("{probe}-{suffix}"), &revision],
            )
            .await
            .map_err(|error| incompatible_schema(format!("journal bounds rejected: {error}")))?;
    }
    let batch_journal = format!("{probe}-journal-min");
    for revision in ["1", "2", MAX_U64_DECIMAL] {
        transaction
            .execute(
                "INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
                 VALUES ($1, $2::text::numeric, 'schema-validator')",
                &[&batch_journal, &revision],
            )
            .await
            .map_err(|error| incompatible_schema(format!("batch bounds rejected: {error}")))?;
    }

    for (label, statement, id, value) in [
        (
            "negative journal revision",
            "INSERT INTO nanocodex_journals (journal_id, revision)
             VALUES ($1, $2::text::numeric)",
            format!("{probe}-journal-negative"),
            "-1",
        ),
        (
            "journal revision above u64",
            "INSERT INTO nanocodex_journals (journal_id, revision)
             VALUES ($1, $2::text::numeric)",
            format!("{probe}-journal-overflow"),
            ABOVE_MAX_U64_DECIMAL,
        ),
    ] {
        expect_check_violation(transaction, label, statement, &[&id, &value]).await?;
    }
    for (label, value) in [
        ("batch revision zero", "0"),
        ("batch revision above u64", ABOVE_MAX_U64_DECIMAL),
    ] {
        expect_check_violation(
            transaction,
            label,
            "INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
             VALUES ($1, $2::text::numeric, 'schema-validator')",
            &[&batch_journal, &value],
        )
        .await?;
    }
    Ok(())
}

async fn validate_owner_numeric_boundaries(
    transaction: &Transaction<'_>,
    probe: &str,
) -> Result<(), StoreError> {
    for (suffix, fence) in [
        ("owner-min", "1"),
        ("owner-interior", "2"),
        ("owner-max", MAX_U64_DECIMAL),
    ] {
        transaction
            .execute(
                "INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
                 VALUES ($1, 'schema-validator', $2::text::numeric)",
                &[&format!("{probe}-{suffix}"), &fence],
            )
            .await
            .map_err(|error| incompatible_schema(format!("owner bounds rejected: {error}")))?;
    }

    for (label, statement, id, value) in [
        (
            "owner fence zero",
            "INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
             VALUES ($1, 'schema-validator', $2::text::numeric)",
            format!("{probe}-owner-zero"),
            "0",
        ),
        (
            "owner fence above u64",
            "INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
             VALUES ($1, 'schema-validator', $2::text::numeric)",
            format!("{probe}-owner-overflow"),
            ABOVE_MAX_U64_DECIMAL,
        ),
    ] {
        expect_check_violation(transaction, label, statement, &[&id, &value]).await?;
    }
    Ok(())
}

async fn expect_check_violation(
    transaction: &Transaction<'_>,
    label: &str,
    statement: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<(), StoreError> {
    transaction
        .batch_execute("SAVEPOINT nanocodex_schema_check")
        .await
        .map_err(backend)?;
    let result = transaction.execute(statement, params).await;
    transaction
        .batch_execute(
            "ROLLBACK TO SAVEPOINT nanocodex_schema_check;
             RELEASE SAVEPOINT nanocodex_schema_check",
        )
        .await
        .map_err(backend)?;
    match result {
        Err(error) if error.code() == Some(&SqlState::CHECK_VIOLATION) => Ok(()),
        Err(error) => Err(incompatible_schema(format!(
            "{label} failed for the wrong reason: {error}"
        ))),
        Ok(_) => Err(incompatible_schema(format!(
            "{label} was accepted by its CHECK constraint"
        ))),
    }
}

fn incompatible_schema(detail: String) -> StoreError {
    StoreError::Backend(format!("incompatible Postgres durability schema: {detail}"))
}

fn parse_u64(value: &str, label: &str) -> Result<u64, StoreError> {
    value
        .parse()
        .map_err(|error| StoreError::Backend(format!("invalid {label}: {error}")))
}

fn native_revision(value: u64) -> Result<i64, StoreError> {
    debug_assert_eq!(MAX_NATIVE_REVISION, i64::MAX as u64);
    i64::try_from(value)
        .map_err(|_| StoreError::NotCommitted("Postgres durability revision overflow".to_owned()))
}

#[cfg(test)]
mod tests {
    use tokio_postgres::NoTls;

    use super::*;
    use crate::{Admission, DurableSession};

    #[test]
    fn signed_64_bit_revision_ceiling_fails_closed() {
        assert_eq!(native_revision(MAX_NATIVE_REVISION), Ok(i64::MAX));
        assert_eq!(
            native_revision(MAX_NATIVE_REVISION + 1),
            Err(StoreError::NotCommitted(
                "Postgres durability revision overflow".to_owned()
            ))
        );
    }

    #[test]
    fn foreign_key_shape_requires_current_schema_and_immediate_enforcement() {
        let canonical = || ForeignKeySpec {
            source_column: "journal_id".to_owned(),
            target_in_current_schema: true,
            target_table: "nanocodex_journals".to_owned(),
            target_column: "journal_id".to_owned(),
            deferrable: false,
            initially_deferred: false,
        };
        assert!(has_canonical_foreign_key(&[canonical()]));

        let mut wrong_schema = canonical();
        wrong_schema.target_in_current_schema = false;
        assert!(!has_canonical_foreign_key(&[wrong_schema]));

        let mut deferrable = canonical();
        deferrable.deferrable = true;
        assert!(!has_canonical_foreign_key(&[deferrable]));

        let mut initially_deferred = canonical();
        initially_deferred.initially_deferred = true;
        assert!(!has_canonical_foreign_key(&[initially_deferred]));
    }

    #[test]
    fn numeric_check_shape_rejects_extra_constraints() {
        let mut checks = canonical_numeric_checks()
            .into_iter()
            .map(|(table, column)| CheckSpec {
                table: table.to_owned(),
                column: Some(column.to_owned()),
            })
            .collect::<Vec<_>>();
        assert!(has_canonical_numeric_checks(&checks));

        checks.insert(
            2,
            CheckSpec {
                table: "nanocodex_journal_owners".to_owned(),
                column: Some("owner_id".to_owned()),
            },
        );
        assert!(!has_canonical_numeric_checks(&checks));
    }

    async fn connect_test_client(url: &str) -> Client {
        let (client, connection) = tokio_postgres::connect(url, NoTls).await.unwrap();
        tokio::spawn(async move {
            connection.await.unwrap();
        });
        client
    }

    #[tokio::test]
    #[ignore = "requires NANOCODEX_TEST_POSTGRES_URL"]
    async fn real_postgres_rejects_bad_schema_and_reopens_shared_numeric_schema() {
        let url = std::env::var("NANOCODEX_TEST_POSTGRES_URL").unwrap();

        let malformed_schema = format!("nanocodex_test_{}", uuid::Uuid::now_v7().simple());
        let malformed = connect_test_client(&url).await;
        malformed
            .batch_execute(&format!(
                "CREATE SCHEMA {malformed_schema};
                 SET search_path TO {malformed_schema};
                 CREATE TABLE nanocodex_journal_owners (
                   journal_id TEXT PRIMARY KEY,
                   owner_id TEXT NOT NULL,
                   fence BIGINT NOT NULL CHECK (fence >= 1)
                 );"
            ))
            .await
            .unwrap();
        let error = match PostgresStore::new(malformed).await {
            Ok(_) => panic!("incompatible ownership schema was accepted"),
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains("`nanocodex_journal_owners.fence` has an incompatible column shape"),
            "unexpected schema error: {error}"
        );
        let cleanup = connect_test_client(&url).await;
        cleanup
            .batch_execute(&format!("DROP SCHEMA {malformed_schema} CASCADE"))
            .await
            .unwrap();
        drop(cleanup);

        let ceiling_schema = format!("nanocodex_test_{}", uuid::Uuid::now_v7().simple());
        let client = connect_test_client(&url).await;
        client
            .batch_execute(&format!(
                "CREATE SCHEMA {ceiling_schema};
                 SET search_path TO {ceiling_schema};
                 CREATE TABLE nanocodex_journal_owners (
                   journal_id TEXT PRIMARY KEY,
                   owner_id TEXT NOT NULL,
                   fence NUMERIC(20, 0) NOT NULL
                     CHECK (fence >= 1 AND fence <= 18446744073709551615)
                 );
                 CREATE TABLE nanocodex_journals (
                   journal_id TEXT PRIMARY KEY,
                   revision NUMERIC(20, 0) NOT NULL
                     CHECK (revision >= 0 AND revision <= 18446744073709551615)
                 );
                 CREATE TABLE nanocodex_journal_batches (
                   journal_id TEXT NOT NULL REFERENCES nanocodex_journals(journal_id),
                   revision NUMERIC(20, 0) NOT NULL
                     CHECK (revision > 0 AND revision <= 18446744073709551615),
                   payload TEXT NOT NULL,
                   PRIMARY KEY (journal_id, revision)
                 )"
            ))
            .await
            .unwrap();
        let mut store = PostgresStore::new(client).await.unwrap();
        let owned = store
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        store
            .client
            .execute(
                "INSERT INTO nanocodex_journals (journal_id, revision) VALUES ($1, $2::bigint)",
                &[&"journal", &i64::MAX],
            )
            .await
            .unwrap();
        assert!(matches!(
            store
                .append("journal", &owned.owner, MAX_NATIVE_REVISION, "overflow")
                .await,
            Err(StoreError::NotCommitted(message))
                if message == "Postgres durability revision overflow"
        ));
        assert_eq!(
            store
                .client
                .query_one(
                    "SELECT revision::text FROM nanocodex_journals
                     WHERE journal_id = 'journal'",
                    &[],
                )
                .await
                .unwrap()
                .get::<_, String>(0),
            i64::MAX.to_string()
        );
        store
            .acquire_owner("owner-ceiling", OwnerId::new())
            .await
            .unwrap();
        store
            .client
            .batch_execute(
                "UPDATE nanocodex_journal_owners
                 SET fence = 18446744073709551614 WHERE journal_id = 'owner-ceiling'",
            )
            .await
            .unwrap();
        let max_owner = OwnerId::new();
        let max_owned = store
            .acquire_owner("owner-ceiling", max_owner.clone())
            .await
            .unwrap();
        assert_eq!(max_owned.owner.fence(), u64::MAX);
        assert!(matches!(
            store.acquire_owner("owner-ceiling", OwnerId::new()).await,
            Err(StoreError::NotCommitted(message))
                if message == "Postgres durability owner fence overflow"
        ));
        assert_eq!(
            store
                .client
                .query_one(
                    "SELECT fence::text FROM nanocodex_journal_owners
                     WHERE journal_id = 'owner-ceiling'",
                    &[],
                )
                .await
                .unwrap()
                .get::<_, String>(0),
            u64::MAX.to_string()
        );
        drop(store);
        let reopened = connect_test_client(&url).await;
        reopened
            .batch_execute(&format!("SET search_path TO {ceiling_schema}"))
            .await
            .unwrap();
        let mut reopened = PostgresStore::new(reopened).await.unwrap();
        let reopened_journal = reopened
            .acquire_owner("journal", OwnerId::new())
            .await
            .unwrap();
        assert_eq!(reopened_journal.journal.revision, MAX_NATIVE_REVISION);
        assert!(matches!(
            reopened
                .append(
                    "journal",
                    &reopened_journal.owner,
                    MAX_NATIVE_REVISION,
                    "overflow"
                )
                .await,
            Err(StoreError::NotCommitted(message))
                if message == "Postgres durability revision overflow"
        ));
        drop(reopened);
        let cleanup = connect_test_client(&url).await;
        cleanup
            .batch_execute(&format!("DROP SCHEMA {ceiling_schema} CASCADE"))
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires NANOCODEX_TEST_POSTGRES_URL"]
    async fn real_postgres_rejects_released_schema_with_unsafe_owner_residue() {
        let url = std::env::var("NANOCODEX_TEST_POSTGRES_URL").unwrap();

        for (case, owners_sql, expected_owner_rows) in [
            (
                "nonempty",
                "CREATE TABLE nanocodex_journal_owners (
                   journal_id TEXT PRIMARY KEY,
                   owner_id TEXT NOT NULL,
                   fence NUMERIC(20, 0) NOT NULL
                     CHECK (fence >= 1 AND fence <= 18446744073709551615)
                 );
                 INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
                 VALUES ('released-journal', 'unknown-owner', 7);",
                1_i64,
            ),
            (
                "malformed",
                "CREATE TABLE nanocodex_journal_owners (
                   journal_id TEXT PRIMARY KEY,
                   owner_id TEXT NOT NULL,
                   fence NUMERIC(20, 0) NOT NULL
                     CHECK (fence >= 2 AND fence <= 18446744073709551615)
                 );",
                0_i64,
            ),
        ] {
            let schema = format!("nanocodex_test_{}", uuid::Uuid::now_v7().simple());
            let client = connect_test_client(&url).await;
            client
                .batch_execute(&format!(
                    "CREATE SCHEMA {schema};
                     SET search_path TO {schema};
                     CREATE TABLE nanocodex_journals (
                       journal_id TEXT PRIMARY KEY,
                       revision BIGINT NOT NULL CHECK (revision >= 0)
                     );
                     CREATE TABLE nanocodex_journal_batches (
                       journal_id TEXT NOT NULL REFERENCES nanocodex_journals(journal_id),
                       revision BIGINT NOT NULL CHECK (revision > 0),
                       payload TEXT NOT NULL,
                       PRIMARY KEY (journal_id, revision)
                     );
                     {owners_sql}
                     INSERT INTO nanocodex_journals (journal_id, revision)
                     VALUES ('released-journal', 1);
                     INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
                     VALUES ('released-journal', 1, 'retained-payload');"
                ))
                .await
                .unwrap();

            let error = match PostgresStore::new(client).await {
                Ok(_) => panic!("released schema with {case} owners was accepted"),
                Err(error) => error,
            };
            assert!(
                error
                    .to_string()
                    .contains("incompatible Postgres durability schema"),
                "unexpected {case} owner error: {error}"
            );

            let audit = connect_test_client(&url).await;
            audit
                .batch_execute(&format!("SET search_path TO {schema}"))
                .await
                .unwrap();
            let revision_types = audit
                .query(
                    "SELECT data_type
                     FROM information_schema.columns
                     WHERE table_schema = current_schema()
                       AND column_name = 'revision'
                       AND table_name IN ('nanocodex_journals', 'nanocodex_journal_batches')
                     ORDER BY table_name",
                    &[],
                )
                .await
                .unwrap();
            assert_eq!(revision_types.len(), 2);
            assert!(
                revision_types
                    .iter()
                    .all(|row| row.get::<_, String>(0) == "bigint")
            );
            assert_eq!(
                audit
                    .query_one("SELECT count(*) FROM nanocodex_journal_owners", &[],)
                    .await
                    .unwrap()
                    .get::<_, i64>(0),
                expected_owner_rows
            );
            assert_eq!(
                audit
                    .query_one(
                        "SELECT payload FROM nanocodex_journal_batches
                         WHERE journal_id = 'released-journal' AND revision = 1",
                        &[],
                    )
                    .await
                    .unwrap()
                    .get::<_, String>(0),
                "retained-payload"
            );
            audit
                .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "requires NANOCODEX_TEST_POSTGRES_URL"]
    async fn real_postgres_upgrades_and_replays_the_released_bigint_schema() {
        let url = std::env::var("NANOCODEX_TEST_POSTGRES_URL").unwrap();
        let schema = format!("nanocodex_test_{}", uuid::Uuid::now_v7().simple());
        let client = connect_test_client(&url).await;
        client
            .batch_execute(&format!(
                r#"CREATE SCHEMA {schema};
                 SET search_path TO {schema};
                 CREATE TABLE nanocodex_journals (
                   journal_id TEXT PRIMARY KEY,
                   revision BIGINT NOT NULL CHECK (revision >= 0)
                 );
                 CREATE TABLE nanocodex_journal_batches (
                   journal_id TEXT NOT NULL REFERENCES nanocodex_journals(journal_id),
                   revision BIGINT NOT NULL CHECK (revision > 0),
                   payload TEXT NOT NULL,
                   PRIMARY KEY (journal_id, revision)
                 );
                 CREATE TABLE nanocodex_journal_owners (
                   journal_id TEXT PRIMARY KEY,
                   owner_id TEXT NOT NULL,
                   fence NUMERIC(20, 0) NOT NULL
                     CHECK (fence >= 1 AND fence <= 18446744073709551615)
                 );
                 INSERT INTO nanocodex_journals (journal_id, revision)
                 VALUES ('released-journal', 4);
                 INSERT INTO nanocodex_journal_batches (journal_id, revision, payload) VALUES
                   ('released-journal', 1, '{{"operation_accepted":{{"operation_id":"legacy-turn","input":"prompt"}}}}'),
                   ('released-journal', 2, '{{"step_started":{{"operation_id":"legacy-turn","step_id":"tool-1","kind":"tool","input":"charge","retry":"idempotent"}}}}'),
                   ('released-journal', 3, '{{"step_completed":{{"operation_id":"legacy-turn","step_id":"tool-1","output":"receipt"}}}}'),
                   ('released-journal', 4, '{{"operation_completed":{{"operation_id":"legacy-turn","checkpoint":{{"version":7}},"output":{{"message":"legacy done"}}}}}}');"#
            ))
            .await
            .unwrap();

        let session = DurableSession::open(
            PostgresStore::new(client).await.unwrap(),
            "released-journal",
        )
        .await
        .unwrap();
        let replay = session
            .admit_typed::<_, serde_json::Value, serde_json::Value>("legacy-turn", &"prompt")
            .await
            .unwrap();
        assert!(matches!(
            replay,
            Admission::Completed { checkpoint, output }
                if checkpoint == serde_json::json!({"version": 7})
                    && output == serde_json::json!({"message": "legacy done"})
        ));
        assert_eq!(session.state().await.unwrap().revision(), 4);
        drop(session);

        let audit = connect_test_client(&url).await;
        audit
            .batch_execute(&format!("SET search_path TO {schema}"))
            .await
            .unwrap();
        let shapes = audit
            .query(
                "SELECT table_name, data_type, numeric_precision, numeric_scale
                 FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND column_name = 'revision'
                   AND table_name IN ('nanocodex_journals', 'nanocodex_journal_batches')
                 ORDER BY table_name",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(shapes.len(), 2);
        for shape in shapes {
            assert_eq!(shape.get::<_, String>(1), "numeric");
            assert_eq!(shape.get::<_, Option<i32>>(2), Some(20));
            assert_eq!(shape.get::<_, Option<i32>>(3), Some(0));
        }
        assert_eq!(
            audit
                .query_one(
                    "SELECT count(*) FROM nanocodex_journal_batches
                     WHERE journal_id = 'released-journal'",
                    &[],
                )
                .await
                .unwrap()
                .get::<_, i64>(0),
            4
        );
        drop(audit);

        let reopened = connect_test_client(&url).await;
        reopened
            .batch_execute(&format!("SET search_path TO {schema}"))
            .await
            .unwrap();
        let mut reopened = PostgresStore::new(reopened).await.unwrap();
        let released = reopened
            .acquire_owner("released-journal", OwnerId::new())
            .await
            .unwrap();
        assert_eq!(released.owner.fence(), 2);
        assert_eq!(released.journal.revision, 4);
        assert_eq!(released.journal.batches.len(), 4);
        let probe = reopened
            .acquire_owner("append-probe", OwnerId::new())
            .await
            .unwrap();
        reopened
            .append(
                "append-probe",
                &probe.owner,
                0,
                r#"{"model_effect_started":{"kind":"probe"}}"#,
            )
            .await
            .unwrap();
        drop(reopened);

        let cleanup = connect_test_client(&url).await;
        cleanup
            .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .await
            .unwrap();
    }
}
