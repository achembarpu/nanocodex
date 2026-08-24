import { durabilityRevision } from "./durability-store.mjs";

const MAX_REVISION = "18446744073709551615";
const ABOVE_MAX_REVISION = "18446744073709551616";
const FAR_ABOVE_MAX_REVISION = "18446744073709551617";
const SCHEMA_ADVISORY_LOCK = "6178124430808978225";
const ZERO_REVISION = durabilityRevision("0");

const POSTGRES_DURABILITY_COLUMNS = [
  ["nanocodex_journal_batches", "journal_id", "text", null, null],
  ["nanocodex_journal_batches", "revision", "numeric", 20, 0],
  ["nanocodex_journal_batches", "payload", "text", null, null],
  ["nanocodex_journal_owners", "journal_id", "text", null, null],
  ["nanocodex_journal_owners", "owner_id", "text", null, null],
  ["nanocodex_journal_owners", "fence", "numeric", 20, 0],
  ["nanocodex_journals", "journal_id", "text", null, null],
  ["nanocodex_journals", "revision", "numeric", 20, 0],
];

const POSTGRES_DURABILITY_PRIMARY_KEYS = [
  ["nanocodex_journal_batches", "journal_id"],
  ["nanocodex_journal_batches", "revision"],
  ["nanocodex_journal_owners", "journal_id"],
  ["nanocodex_journals", "journal_id"],
];

const POSTGRES_DURABILITY_NUMERIC_CHECKS = [
  ["nanocodex_journal_batches", "revision"],
  ["nanocodex_journal_owners", "fence"],
  ["nanocodex_journals", "revision"],
];

const POSTGRES_DURABILITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nanocodex_journal_owners (
     journal_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     fence NUMERIC(20, 0) NOT NULL
       CHECK (fence >= 1 AND fence <= 18446744073709551615)
   )`,
  `CREATE TABLE IF NOT EXISTS nanocodex_journals (
     journal_id TEXT PRIMARY KEY,
     revision NUMERIC(20, 0) NOT NULL
       CHECK (revision >= 0 AND revision <= 18446744073709551615)
   )`,
  `CREATE TABLE IF NOT EXISTS nanocodex_journal_batches (
     journal_id TEXT NOT NULL REFERENCES nanocodex_journals(journal_id),
     revision NUMERIC(20, 0) NOT NULL
       CHECK (revision > 0 AND revision <= 18446744073709551615),
     payload TEXT NOT NULL,
     PRIMARY KEY (journal_id, revision)
   )`,
];

export class UnknownPostgresCommitOutcomeError extends Error {
  name = "UnknownPostgresCommitOutcomeError";

  constructor(journalId, cause) {
    super(
      `PostgreSQL durability COMMIT outcome is unknown for journal ${JSON.stringify(journalId)}`,
      { cause },
    );
  }
}

export function createPostgresDurabilityStore(pool) {
  requirePool(pool);
  let schemaReady;

  const readyPool = async () => {
    const attempt = schemaReady ??= initializeSchema(pool);
    try {
      return await attempt;
    } catch (error) {
      if (schemaReady === attempt) schemaReady = undefined;
      throw error;
    }
  };

  return Object.freeze({
    async load(journalId) {
      requireJournalId(journalId);
      return loadJournal(await readyPool(), journalId);
    },

    async acquire(journalId, request) {
      requireJournalId(journalId);
      const ownerId = requireOwnerId(request?.ownerId);
      return acquireJournal(await readyPool(), journalId, ownerId);
    },

    async append(journalId, request) {
      requireJournalId(journalId);
      requireAppendRequest(request);
      return appendJournal(await readyPool(), journalId, request);
    },
  });
}

async function acquireJournal(pool, journalId, ownerId) {
  const client = await pool.connect();
  let transactionStarted = false;
  let commitAttempted = false;
  let discardClient = true;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    discardClient = false;
    const acquired = await client.query(
      `INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
       VALUES ($1, $2, 1)
       ON CONFLICT (journal_id) DO UPDATE
         SET owner_id = excluded.owner_id,
             fence = nanocodex_journal_owners.fence + 1
       WHERE nanocodex_journal_owners.fence < 18446744073709551615
       RETURNING fence::text AS fence`,
      [journalId, ownerId],
    );
    const row = acquired.rows[0];
    if (!row) {
      await rollback(client);
      transactionStarted = false;
      throw new RangeError("PostgreSQL durability fence overflow");
    }
    const fence = storedFence(row.fence, "acquired owner");
    const journal = await loadJournal(client, journalId);

    commitAttempted = true;
    try {
      await client.query("COMMIT");
    } catch (error) {
      discardClient = true;
      throw new UnknownPostgresCommitOutcomeError(journalId, error);
    }
    transactionStarted = false;
    return { ownerId, fence, ...journal };
  } catch (error) {
    if (transactionStarted && !commitAttempted) {
      discardClient = true;
      try {
        await rollback(client);
        transactionStarted = false;
        discardClient = false;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `PostgreSQL durability acquire and rollback both failed for journal ${JSON.stringify(journalId)}`,
        );
      }
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

async function initializeSchema(pool) {
  const client = await pool.connect();
  let transactionStarted = false;
  let commitAttempted = false;
  let discardClient = true;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    discardClient = false;
    await client.query(
      "SELECT pg_advisory_xact_lock($1::bigint)",
      [SCHEMA_ADVISORY_LOCK],
    );
    for (const statement of POSTGRES_DURABILITY_SCHEMA) {
      await client.query(statement);
    }
    await validateSchema(client);
    commitAttempted = true;
    try {
      await client.query("COMMIT");
    } catch (error) {
      discardClient = true;
      throw error;
    }
    transactionStarted = false;
    return pool;
  } catch (error) {
    if (transactionStarted && !commitAttempted) {
      discardClient = true;
      try {
        await rollback(client);
        transactionStarted = false;
        discardClient = false;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "PostgreSQL durability schema initialization and rollback both failed",
        );
      }
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

async function validateSchema(client) {
  const columns = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable,
            numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN (
          'nanocodex_journals',
          'nanocodex_journal_batches',
          'nanocodex_journal_owners'
        )
      ORDER BY table_name, ordinal_position`,
  );
  if (columns.rows.length !== POSTGRES_DURABILITY_COLUMNS.length) {
    throw incompatibleSchema(
      `the three journal tables must contain exactly ${POSTGRES_DURABILITY_COLUMNS.length} columns, found ${columns.rows.length}`,
    );
  }
  for (let index = 0; index < POSTGRES_DURABILITY_COLUMNS.length; index += 1) {
    const row = columns.rows[index];
    const [table, column, dataType, precision, scale] = POSTGRES_DURABILITY_COLUMNS[index];
    if (
      row?.table_name !== table
      || row.column_name !== column
      || row.data_type !== dataType
      || row.is_nullable !== "NO"
      || !catalogIntegerEquals(row.numeric_precision, precision)
      || !catalogIntegerEquals(row.numeric_scale, scale)
    ) {
      throw incompatibleSchema(`\`${table}.${column}\` has an incompatible column shape`);
    }
  }

  const primaryKeys = await client.query(
    `SELECT retained_table.relname AS table_name,
            attribute.attname AS column_name
       FROM pg_class AS retained_table
       JOIN pg_namespace AS retained_schema
         ON retained_schema.oid = retained_table.relnamespace
       JOIN pg_index AS retained_index
         ON retained_index.indrelid = retained_table.oid
       CROSS JOIN LATERAL unnest(retained_index.indkey)
         WITH ORDINALITY AS key(attnum, position)
       JOIN pg_attribute AS attribute
         ON attribute.attrelid = retained_index.indrelid
        AND attribute.attnum = key.attnum
      WHERE retained_schema.nspname = current_schema()
        AND retained_table.relname IN (
          'nanocodex_journals',
          'nanocodex_journal_batches',
          'nanocodex_journal_owners'
        )
        AND retained_index.indisprimary
      ORDER BY retained_table.relname, key.position`,
  );
  if (!catalogPairsEqual(primaryKeys.rows, POSTGRES_DURABILITY_PRIMARY_KEYS)) {
    throw incompatibleSchema("the journal tables have incompatible PRIMARY KEY constraints");
  }

  const foreignKeys = await client.query(
    `SELECT source_attribute.attname AS source_column,
            target_schema.nspname = current_schema() AS target_in_current_schema,
            target_table.relname AS target_table,
            target_attribute.attname AS target_column,
            retained_constraint.condeferrable AS is_deferrable,
            retained_constraint.condeferred AS is_initially_deferred
       FROM pg_constraint AS retained_constraint
       JOIN pg_class AS source_table
         ON source_table.oid = retained_constraint.conrelid
       JOIN pg_namespace AS source_schema
         ON source_schema.oid = source_table.relnamespace
       CROSS JOIN LATERAL unnest(retained_constraint.conkey, retained_constraint.confkey)
         WITH ORDINALITY AS key(source_attnum, target_attnum, position)
       JOIN pg_attribute AS source_attribute
         ON source_attribute.attrelid = retained_constraint.conrelid
        AND source_attribute.attnum = key.source_attnum
       JOIN pg_class AS target_table
         ON target_table.oid = retained_constraint.confrelid
       JOIN pg_namespace AS target_schema
         ON target_schema.oid = target_table.relnamespace
       JOIN pg_attribute AS target_attribute
         ON target_attribute.attrelid = retained_constraint.confrelid
        AND target_attribute.attnum = key.target_attnum
      WHERE source_schema.nspname = current_schema()
        AND source_table.relname = 'nanocodex_journal_batches'
        AND retained_constraint.contype = 'f'
      ORDER BY retained_constraint.oid, key.position`,
  );
  if (
    foreignKeys.rows.length !== 1
    || foreignKeys.rows[0]?.source_column !== "journal_id"
    || foreignKeys.rows[0]?.target_in_current_schema !== true
    || foreignKeys.rows[0]?.target_table !== "nanocodex_journals"
    || foreignKeys.rows[0]?.target_column !== "journal_id"
    || foreignKeys.rows[0]?.is_deferrable !== false
    || foreignKeys.rows[0]?.is_initially_deferred !== false
  ) {
    throw incompatibleSchema("`nanocodex_journal_batches` has an incompatible foreign key");
  }

  await validateNumericChecks(client);
}

function catalogPairsEqual(rows, expected) {
  return rows.length === expected.length && rows.every((row, index) => (
    row?.table_name === expected[index][0]
    && row.column_name === expected[index][1]
  ));
}

async function validateNumericChecks(client) {
  const checks = await client.query(
    `SELECT retained_table.relname AS table_name,
            attribute.attname AS column_name
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
      ORDER BY retained_table.relname, retained_constraint.oid`,
  );
  const retainedChecks = new Set(
    checks.rows.map((row) => `${row?.table_name}.${row?.column_name}`),
  );
  for (const [table, column] of POSTGRES_DURABILITY_NUMERIC_CHECKS) {
    if (!retainedChecks.has(`${table}.${column}`)) {
      throw incompatibleSchema(`\`${table}.${column}\` must have a single-column CHECK constraint`);
    }
  }
  if (!catalogPairsEqual(checks.rows, POSTGRES_DURABILITY_NUMERIC_CHECKS)) {
    throw incompatibleSchema("the journal tables have incompatible CHECK constraints");
  }

  const probe = `nanocodex-schema-validator-${globalThis.crypto.randomUUID()}`;
  await client.query("SAVEPOINT nanocodex_schema_validation");
  let validationError;
  try {
    await validateNumericBoundaries(client, probe);
  } catch (error) {
    validationError = error;
  }
  try {
    await client.query("ROLLBACK TO SAVEPOINT nanocodex_schema_validation");
    await client.query("RELEASE SAVEPOINT nanocodex_schema_validation");
  } catch (cleanupError) {
    if (validationError !== undefined) {
      throw new AggregateError(
        [validationError, cleanupError],
        "PostgreSQL durability schema validation and savepoint cleanup both failed",
      );
    }
    throw cleanupError;
  }
  if (validationError !== undefined) throw validationError;
}

async function validateNumericBoundaries(client, probe) {
  for (const [suffix, fence] of [
    ["owner-min", "1"],
    ["owner-interior", "2"],
    ["owner-max", MAX_REVISION],
  ]) {
    await expectBoundaryAccepted(
      client,
      "owner bounds",
      `INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
       VALUES ($1, 'schema-validator', $2::text::numeric)`,
      [`${probe}-${suffix}`, fence],
    );
  }
  for (const [suffix, revision] of [
    ["journal-min", "0"],
    ["journal-interior", "1"],
    ["journal-max", MAX_REVISION],
  ]) {
    await expectBoundaryAccepted(
      client,
      "journal bounds",
      `INSERT INTO nanocodex_journals (journal_id, revision)
       VALUES ($1, $2::text::numeric)`,
      [`${probe}-${suffix}`, revision],
    );
  }
  const batchJournal = `${probe}-journal-min`;
  for (const revision of ["1", "2", MAX_REVISION]) {
    await expectBoundaryAccepted(
      client,
      "batch bounds",
      `INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
       VALUES ($1, $2::text::numeric, 'schema-validator')`,
      [batchJournal, revision],
    );
  }

  for (const [label, statement, id, value] of [
    [
      "negative owner fence",
      `INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
       VALUES ($1, 'schema-validator', $2::text::numeric)`,
      `${probe}-owner-negative`,
      "-1",
    ],
    [
      "owner fence zero",
      `INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
       VALUES ($1, 'schema-validator', $2::text::numeric)`,
      `${probe}-owner-zero`,
      "0",
    ],
    [
      "owner fence above u64",
      `INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
       VALUES ($1, 'schema-validator', $2::text::numeric)`,
      `${probe}-owner-overflow`,
      ABOVE_MAX_REVISION,
    ],
    [
      "owner fence farther above u64",
      `INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence)
       VALUES ($1, 'schema-validator', $2::text::numeric)`,
      `${probe}-owner-far-overflow`,
      FAR_ABOVE_MAX_REVISION,
    ],
    [
      "negative journal revision",
      `INSERT INTO nanocodex_journals (journal_id, revision)
       VALUES ($1, $2::text::numeric)`,
      `${probe}-journal-negative`,
      "-1",
    ],
    [
      "journal revision above u64",
      `INSERT INTO nanocodex_journals (journal_id, revision)
       VALUES ($1, $2::text::numeric)`,
      `${probe}-journal-overflow`,
      ABOVE_MAX_REVISION,
    ],
    [
      "journal revision farther above u64",
      `INSERT INTO nanocodex_journals (journal_id, revision)
       VALUES ($1, $2::text::numeric)`,
      `${probe}-journal-far-overflow`,
      FAR_ABOVE_MAX_REVISION,
    ],
  ]) {
    await expectCheckViolation(client, label, statement, [id, value]);
  }
  for (const [label, value] of [
    ["negative batch revision", "-1"],
    ["batch revision zero", "0"],
    ["batch revision above u64", ABOVE_MAX_REVISION],
    ["batch revision farther above u64", FAR_ABOVE_MAX_REVISION],
  ]) {
    await expectCheckViolation(
      client,
      label,
      `INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
       VALUES ($1, $2::text::numeric, 'schema-validator')`,
      [batchJournal, value],
    );
  }
}

async function expectBoundaryAccepted(client, label, statement, values) {
  try {
    await client.query(statement, values);
  } catch (error) {
    throw incompatibleSchema(`${label} rejected: ${errorMessage(error)}`);
  }
}

async function expectCheckViolation(client, label, statement, values) {
  await client.query("SAVEPOINT nanocodex_schema_check");
  let result;
  try {
    await client.query(statement, values);
    result = { accepted: true };
  } catch (error) {
    result = { error };
  }
  await client.query("ROLLBACK TO SAVEPOINT nanocodex_schema_check");
  await client.query("RELEASE SAVEPOINT nanocodex_schema_check");
  if (result.error?.code === "23514") return;
  if (result.error !== undefined) {
    throw incompatibleSchema(`${label} failed for the wrong reason: ${errorMessage(result.error)}`);
  }
  throw incompatibleSchema(`${label} was accepted by its CHECK constraint`);
}

function catalogIntegerEquals(value, expected) {
  if (expected === null) return value === null;
  if (typeof value === "number") return Number.isInteger(value) && value === expected;
  if (typeof value === "bigint") return value === BigInt(expected);
  return typeof value === "string" && value === String(expected);
}

function incompatibleSchema(detail) {
  return new Error(
    `incompatible Postgres durability schema: ${detail}; recreate the three \`nanocodex_journal_*\` tables with the current schema`,
  );
}

async function loadJournal(pool, journalId) {
  const result = await pool.query(
    `SELECT journal.revision::text AS head_revision,
            batch.revision::text AS batch_revision,
            batch.payload
       FROM nanocodex_journals AS journal
       LEFT JOIN nanocodex_journal_batches AS batch
         ON batch.journal_id = journal.journal_id
      WHERE journal.journal_id = $1
      ORDER BY batch.revision ASC`,
    [journalId],
  );
  if (result.rows.length === 0) return { revision: ZERO_REVISION, batches: [] };

  const revision = storedRevision(result.rows[0]?.head_revision, "journal head");
  const batches = result.rows.flatMap((row, index) => {
    if (storedRevision(row.head_revision, "journal head") !== revision) {
      throw new Error(
        `PostgreSQL returned inconsistent heads while loading journal ${JSON.stringify(journalId)}`,
      );
    }
    if (row.batch_revision === null && row.payload === null && index === 0) return [];
    if (row.batch_revision === null || row.payload === null) {
      throw new Error(
        `PostgreSQL returned an incomplete batch while loading journal ${JSON.stringify(journalId)}`,
      );
    }
    return [{
      revision: storedRevision(row.batch_revision, "journal batch"),
      payload: row.payload,
    }];
  });
  return { revision, batches };
}

async function appendJournal(pool, journalId, request) {
  const ownerId = requireOwnerId(request.ownerId);
  const fence = durabilityRevision(request.fence);
  const expectedRevision = durabilityRevision(request.expectedRevision);
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    return {
      status: "not_committed",
      message: `PostgreSQL transaction was not started: ${errorMessage(error)}`,
    };
  }

  let transactionStarted = false;
  let commitAttempted = false;
  let discardClient = true;
  try {
    try {
      await client.query("BEGIN");
    } catch (error) {
      return {
        status: "not_committed",
        message: `PostgreSQL transaction did not begin: ${errorMessage(error)}`,
      };
    }
    transactionStarted = true;
    discardClient = false;
    const owners = await client.query(
      `SELECT owner_id, fence::text AS fence
         FROM nanocodex_journal_owners
        WHERE journal_id = $1
        FOR UPDATE`,
      [journalId],
    );
    const storedOwner = owners.rows[0];
    if (
      storedOwner?.owner_id !== ownerId
      || storedFence(storedOwner?.fence, "journal owner") !== fence
    ) {
      await rollback(client);
      transactionStarted = false;
      return { status: "fenced" };
    }
    await client.query(
      `INSERT INTO nanocodex_journals (journal_id, revision)
       VALUES ($1, 0)
       ON CONFLICT (journal_id) DO NOTHING`,
      [journalId],
    );
    const advanced = await client.query(
      `UPDATE nanocodex_journals
          SET revision = revision + 1
        WHERE journal_id = $1
          AND revision = $2::numeric
          AND revision < 18446744073709551615
      RETURNING revision::text AS revision`,
      [journalId, expectedRevision],
    );

    const row = advanced.rows[0];
    if (!row) {
      const actual = await client.query(
        `SELECT revision::text AS revision
           FROM nanocodex_journals
          WHERE journal_id = $1`,
        [journalId],
      );
      const actualRevision = storedRevision(actual.rows[0]?.revision, "journal head");
      await rollback(client);
      transactionStarted = false;
      if (actualRevision === expectedRevision && actualRevision === MAX_REVISION) {
        return {
          status: "not_committed",
          message: "PostgreSQL durability revision overflow",
        };
      }
      return { status: "conflict", actualRevision };
    }

    const revision = storedRevision(row.revision, "appended journal");
    await client.query(
      `INSERT INTO nanocodex_journal_batches (journal_id, revision, payload)
       VALUES ($1, $2::numeric, $3)`,
      [journalId, revision, request.payload],
    );

    commitAttempted = true;
    try {
      await client.query("COMMIT");
    } catch (error) {
      discardClient = true;
      throw new UnknownPostgresCommitOutcomeError(journalId, error);
    }
    transactionStarted = false;
    return { status: "appended", revision };
  } catch (error) {
    if (transactionStarted && !commitAttempted) {
      discardClient = true;
      try {
        await rollback(client);
        transactionStarted = false;
        discardClient = false;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `PostgreSQL durability append and rollback both failed for journal ${JSON.stringify(journalId)}`,
        );
      }
      return {
        status: "not_committed",
        message: `PostgreSQL durability append was rolled back: ${errorMessage(error)}`,
      };
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

async function rollback(client) {
  await client.query("ROLLBACK");
}

function storedRevision(value, owner) {
  if (typeof value !== "string") {
    throw new Error(`PostgreSQL ${owner} revision must be returned as decimal text`);
  }
  return durabilityRevision(value);
}

function storedFence(value, owner) {
  if (typeof value !== "string") {
    throw new Error(`PostgreSQL ${owner} fence must be returned as decimal text`);
  }
  return durabilityRevision(value);
}

function requirePool(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("PostgreSQL durability requires a pool with connect and query methods");
  }
}

function requireJournalId(journalId) {
  if (typeof journalId !== "string" || !journalId.trim()) {
    throw new TypeError("durability journal ID must be a non-empty string");
  }
}

function requireAppendRequest(request) {
  requireOwnerId(request?.ownerId);
  durabilityRevision(request?.fence);
  durabilityRevision(request?.expectedRevision);
  if (typeof request?.payload !== "string") {
    throw new TypeError("durability batch payload must be a string");
  }
}

function requireOwnerId(ownerId) {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new TypeError("durability owner ID must be a non-empty string");
  }
  return ownerId;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
