import { durabilityRevision } from "./durability-store.mjs";

const MAX_REVISION = "18446744073709551615";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nanocodex_durable_owners (
     state_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     fence NUMERIC(20, 0) NOT NULL
       CHECK (fence >= 1 AND fence <= 18446744073709551615)
   )`,
  `CREATE TABLE IF NOT EXISTS nanocodex_durable_states (
     state_id TEXT PRIMARY KEY,
     revision NUMERIC(20, 0) NOT NULL
       CHECK (revision >= 1 AND revision <= 18446744073709551615),
     payload TEXT NOT NULL
   )`,
];

export class UnknownPostgresCommitOutcomeError extends Error {
  constructor(stateId, cause) {
    super(`PostgreSQL durability COMMIT outcome is unknown for state ${JSON.stringify(stateId)}`, {
      cause,
    });
    this.name = "UnknownPostgresCommitOutcomeError";
  }
}

/** Creates a concrete PostgreSQL-backed Nanocodex durability store. */
export function createPostgresDurabilityStore(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("PostgreSQL durability requires a connection pool");
  }
  let initialized;
  const ready = () => {
    initialized ??= initialize(pool).catch((error) => {
      initialized = undefined;
      throw error;
    });
    return initialized;
  };
  return Object.freeze({
    async load(stateId) {
      requireId(stateId);
      await ready();
      return loadState(pool, stateId);
    },
    async acquire(stateId, request) {
      requireId(stateId);
      const ownerId = requireOwner(request?.ownerId);
      await ready();
      return acquireState(pool, stateId, ownerId);
    },
    async replace(stateId, request) {
      requireId(stateId);
      const ownerId = requireOwner(request?.ownerId);
      const fence = durabilityRevision(request?.fence);
      const expectedRevision = durabilityRevision(request?.expectedRevision);
      if (typeof request?.payload !== "string") {
        throw new TypeError("durability payload must be a string");
      }
      await ready();
      return replaceState(pool, stateId, {
        ownerId,
        fence,
        expectedRevision,
        payload: request.payload,
      });
    },
  });
}

async function initialize(pool) {
  const client = await pool.connect();
  let begun = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    begun = true;
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         current_database() || ':' || current_schema() || ':nanocodex-durability-v2', 0
       ))`,
    );
    for (const statement of SCHEMA) await client.query(statement);
    const columns = await client.query(
      `SELECT table_name, column_name, data_type, is_nullable,
              numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('nanocodex_durable_owners', 'nanocodex_durable_states')
       ORDER BY table_name, ordinal_position`,
    );
    if (!validColumns(columns.rows)) {
      throw new Error(
        "incompatible Postgres durability schema; recreate the two nanocodex_durable_* tables",
      );
    }
    const primaryKeys = await client.query(
      `SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints AS tc
       JOIN information_schema.key_column_usage AS kcu
         ON tc.constraint_catalog = kcu.constraint_catalog
        AND tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
       WHERE tc.table_schema = current_schema()
         AND tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_name IN ('nanocodex_durable_owners', 'nanocodex_durable_states')
       ORDER BY tc.table_name, kcu.ordinal_position`,
    );
    if (!validPrimaryKeys(primaryKeys.rows)) {
      throw new Error(
        "incompatible Postgres durability primary keys; each state_id must be the sole primary key",
      );
    }
    await client.query("COMMIT");
    begun = false;
  } catch (error) {
    if (begun) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = true;
        throw new AggregateError(
          [error, rollbackError],
          "PostgreSQL durability initialization and rollback both failed",
        );
      }
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

function validPrimaryKeys(rows) {
  const expected = [
    ["nanocodex_durable_owners", "state_id", 1],
    ["nanocodex_durable_states", "state_id", 1],
  ];
  return rows.length === expected.length && rows.every((row, index) =>
    row.table_name === expected[index][0]
      && row.column_name === expected[index][1]
      && row.ordinal_position === expected[index][2]);
}

function validColumns(rows) {
  const expected = [
    ["nanocodex_durable_owners", "state_id", "text", "NO", null, null],
    ["nanocodex_durable_owners", "owner_id", "text", "NO", null, null],
    ["nanocodex_durable_owners", "fence", "numeric", "NO", 20, 0],
    ["nanocodex_durable_states", "state_id", "text", "NO", null, null],
    ["nanocodex_durable_states", "revision", "numeric", "NO", 20, 0],
    ["nanocodex_durable_states", "payload", "text", "NO", null, null],
  ];
  return rows.length === expected.length && rows.every((row, index) => {
    const shape = expected[index];
    return row.table_name === shape[0]
      && row.column_name === shape[1]
      && row.data_type === shape[2]
      && row.is_nullable === shape[3]
      && (row.numeric_precision ?? null) === shape[4]
      && (row.numeric_scale ?? null) === shape[5];
  });
}

async function loadState(queryable, stateId) {
  const result = await queryable.query(
    `SELECT revision::text, payload FROM nanocodex_durable_states WHERE state_id = $1`,
    [stateId],
  );
  if (result.rows.length === 0) return Object.freeze({ revision: "0", payload: null });
  if (result.rows.length !== 1 || typeof result.rows[0].payload !== "string") {
    throw new Error(`PostgreSQL returned invalid durability state ${JSON.stringify(stateId)}`);
  }
  return Object.freeze({
    revision: durabilityRevision(result.rows[0].revision),
    payload: result.rows[0].payload,
  });
}

async function acquireState(pool, stateId, ownerId) {
  const client = await pool.connect();
  let begun = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const owner = await client.query(
      `INSERT INTO nanocodex_durable_owners (state_id, owner_id, fence)
       VALUES ($1, $2, 1)
       ON CONFLICT (state_id) DO UPDATE
       SET owner_id = excluded.owner_id, fence = nanocodex_durable_owners.fence + 1
       WHERE nanocodex_durable_owners.fence < 18446744073709551615
       RETURNING fence::text`,
      [stateId, ownerId],
    );
    if (owner.rows.length !== 1) {
      throw new RangeError("PostgreSQL durability fence overflow");
    }
    const fence = durabilityRevision(owner.rows[0].fence);
    const state = await loadState(client, stateId);
    try {
      await client.query("COMMIT");
      begun = false;
    } catch (error) {
      discard = true;
      throw new UnknownPostgresCommitOutcomeError(stateId, error);
    }
    return Object.freeze({ ownerId, fence, ...state });
  } catch (error) {
    if (error instanceof UnknownPostgresCommitOutcomeError) throw error;
    if (begun) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = true;
        throw new AggregateError(
          [error, rollbackError],
          "PostgreSQL durability acquire and rollback both failed",
        );
      }
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

async function replaceState(pool, stateId, request) {
  const client = await pool.connect();
  let begun = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const owner = await client.query(
      `SELECT owner_id, fence::text FROM nanocodex_durable_owners
       WHERE state_id = $1 FOR UPDATE`,
      [stateId],
    );
    const retained = owner.rows[0];
    if (retained?.owner_id !== request.ownerId
      || durabilityRevision(retained?.fence ?? "0") !== request.fence) {
      await client.query("ROLLBACK");
      begun = false;
      return { status: "fenced" };
    }
    const state = await loadStateForUpdate(client, stateId);
    if (state.revision !== request.expectedRevision) {
      await client.query("ROLLBACK");
      begun = false;
      return { status: "conflict", actualRevision: state.revision };
    }
    if (state.revision === MAX_REVISION) {
      await client.query("ROLLBACK");
      begun = false;
      return { status: "not_committed", message: "PostgreSQL durability revision overflow" };
    }
    const revision = durabilityRevision(BigInt(state.revision) + 1n);
    await client.query(
      `INSERT INTO nanocodex_durable_states (state_id, revision, payload)
       VALUES ($1, $2::numeric, $3)
       ON CONFLICT (state_id) DO UPDATE
       SET revision = excluded.revision, payload = excluded.payload`,
      [stateId, revision, request.payload],
    );
    try {
      await client.query("COMMIT");
      begun = false;
    } catch (error) {
      discard = true;
      throw new UnknownPostgresCommitOutcomeError(stateId, error);
    }
    return { status: "replaced", revision };
  } catch (error) {
    if (error instanceof UnknownPostgresCommitOutcomeError) throw error;
    if (begun) {
      try {
        await client.query("ROLLBACK");
        begun = false;
        return { status: "not_committed", message: message(error) };
      } catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "PostgreSQL durability replace and rollback both failed");
      }
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

async function loadStateForUpdate(client, stateId) {
  const result = await client.query(
    `SELECT revision::text, payload FROM nanocodex_durable_states
     WHERE state_id = $1 FOR UPDATE`,
    [stateId],
  );
  if (result.rows.length === 0) return { revision: "0", payload: null };
  if (result.rows.length !== 1 || typeof result.rows[0].payload !== "string") {
    throw new Error("PostgreSQL returned invalid durable state");
  }
  return { revision: durabilityRevision(result.rows[0].revision), payload: result.rows[0].payload };
}

function requireId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("durability state ID must be a non-empty string");
  }
}

function requireOwner(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("durability owner ID must be a non-empty string");
  }
  return value;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
