import { durabilityRevision } from "./durability-store.mjs";

const MAX_REVISION = "18446744073709551615";
const SCHEMA_ADVISORY_LOCK = "6178124430808978225";
const ZERO_REVISION = durabilityRevision("0");

const POSTGRES_DURABILITY_SCHEMA = [
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

    async append(journalId, request) {
      requireJournalId(journalId);
      requireAppendRequest(request);
      return appendJournal(await readyPool(), journalId, request);
    },
  });
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
  durabilityRevision(request?.expectedRevision);
  if (typeof request?.payload !== "string") {
    throw new TypeError("durability batch payload must be a string");
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
