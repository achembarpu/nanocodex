const MAX_REVISION = 18_446_744_073_709_551_615n;
const MAX_REVISION_TEXT = String(MAX_REVISION);

export const sqliteDurabilitySchema = Object.freeze([
  `CREATE TABLE IF NOT EXISTS nanocodex_durable_owners (
     state_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     fence TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS nanocodex_durable_states (
     state_id TEXT PRIMARY KEY,
     revision TEXT NOT NULL,
     payload TEXT NOT NULL
   )`,
]);

export function durabilityRevision(value) {
  return durabilityUint64(value, "revision");
}

function durabilityFence(value) {
  return durabilityUint64(value, "fence");
}

function durabilityUint64(value, field) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(
      `durability ${field} numbers must be nonnegative safe integers; `
      + "use exact unsigned decimal text for larger values",
    );
  }
  if (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") {
    throw new TypeError(`durability ${field} must be an unsigned 64-bit decimal string`);
  }
  const encoded = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(encoded) || BigInt(encoded) > MAX_REVISION) {
    throw new TypeError(`durability ${field} must be an unsigned 64-bit decimal string`);
  }
  return encoded;
}

export function createMemoryDurabilityStore(stateId, initial) {
  requireId(stateId, "state");
  let state = copyState(initial ?? { revision: "0", payload: null });
  let owner;
  const select = (selected) => {
    if (selected !== stateId) throw new Error(`unknown durability state: ${selected}`);
  };
  return Object.freeze({
    stateId,
    load(selected) {
      select(selected);
      return state;
    },
    acquire(selected, request) {
      select(selected);
      const ownerId = requireId(request?.ownerId, "owner");
      const previousFence = owner?.fence ?? "0";
      if (previousFence === MAX_REVISION_TEXT) {
        throw new RangeError("in-memory durability fence overflow");
      }
      owner = Object.freeze({
        ownerId,
        fence: durabilityFence(BigInt(previousFence) + 1n),
      });
      return acquiredState(owner, state);
    },
    replace(selected, request) {
      select(selected);
      const ownerId = requireId(request?.ownerId, "owner");
      const fence = durabilityFence(request?.fence);
      if (ownerId !== owner?.ownerId || fence !== owner.fence) return { status: "fenced" };
      const expectedRevision = durabilityRevision(request?.expectedRevision);
      if (expectedRevision !== state.revision) {
        return { status: "conflict", actualRevision: state.revision };
      }
      if (expectedRevision === MAX_REVISION_TEXT) {
        return { status: "not_committed", message: "in-memory durability revision overflow" };
      }
      const payload = requirePayload(request?.payload);
      const revision = durabilityRevision(BigInt(expectedRevision) + 1n);
      state = Object.freeze({ revision, payload });
      return { status: "replaced", revision };
    },
    snapshot() {
      return state;
    },
  });
}

export function createSqliteDurabilityStore(options) {
  if (!options || typeof options.transaction !== "function") {
    throw new TypeError("SQLite durability requires a transaction function");
  }
  return Object.freeze({
    load(stateId) {
      requireId(stateId, "state");
      return options.transaction((query) => loadSqliteState(query, stateId));
    },
    acquire(stateId, request) {
      requireId(stateId, "state");
      const ownerId = requireId(request?.ownerId, "owner");
      return options.transaction((query) => mapMaybePromise(
        query(
          "SELECT owner_id, fence FROM nanocodex_durable_owners WHERE state_id = ?",
          [stateId],
        ),
        (owners) => {
          exactRows(owners, 1, "SQLite durability owner");
          if (owners.length === 1) exactObject(owners[0], ["owner_id", "fence"], "SQLite durability owner");
          const previousFence = durabilityFence(owners[0]?.fence ?? "0");
          if (previousFence === MAX_REVISION_TEXT) {
            throw new RangeError("SQLite durability fence overflow");
          }
          const fence = durabilityFence(BigInt(previousFence) + 1n);
          return mapMaybePromise(
            query(
              `INSERT INTO nanocodex_durable_owners (state_id, owner_id, fence) VALUES (?, ?, ?)
               ON CONFLICT (state_id) DO UPDATE
               SET owner_id = excluded.owner_id, fence = excluded.fence`,
              [stateId, ownerId, fence],
            ),
            () => mapMaybePromise(
              loadSqliteState(query, stateId),
              (state) => acquiredState({ ownerId, fence }, state),
            ),
          );
        },
      ));
    },
    replace(stateId, request) {
      requireId(stateId, "state");
      const ownerId = requireId(request?.ownerId, "owner");
      const fence = durabilityFence(request?.fence);
      return options.transaction((query) => mapMaybePromise(
        query(
          "SELECT owner_id, fence FROM nanocodex_durable_owners WHERE state_id = ?",
          [stateId],
        ),
        (owners) => {
          exactRows(owners, 1, "SQLite durability owner");
          if (owners.length === 1) exactObject(owners[0], ["owner_id", "fence"], "SQLite durability owner");
          const storedOwner = owners[0];
          if (
            storedOwner?.owner_id !== ownerId
            || durabilityFence(storedOwner?.fence ?? "0") !== fence
          ) {
            return { status: "fenced" };
          }
          const expectedRevision = durabilityRevision(request?.expectedRevision);
          return mapMaybePromise(loadSqliteState(query, stateId), (state) => {
            if (state.revision !== expectedRevision) {
              return { status: "conflict", actualRevision: state.revision };
            }
            if (expectedRevision === MAX_REVISION_TEXT) {
              return { status: "not_committed", message: "SQLite durability revision overflow" };
            }
            const payload = requirePayload(request?.payload);
            const revision = durabilityRevision(BigInt(expectedRevision) + 1n);
            return mapMaybePromise(
              query(
                `INSERT INTO nanocodex_durable_states (state_id, revision, payload) VALUES (?, ?, ?)
                 ON CONFLICT (state_id) DO UPDATE
                 SET revision = excluded.revision, payload = excluded.payload`,
                [stateId, revision, payload],
              ),
              () => ({ status: "replaced", revision }),
            );
          });
        },
      ));
    },
  });
}

function loadSqliteState(query, stateId) {
  return mapMaybePromise(
    query(
      "SELECT revision, payload FROM nanocodex_durable_states WHERE state_id = ?",
      [stateId],
    ),
    (rows) => {
      exactRows(rows, 1, "SQLite durability state");
      if (rows.length === 0) return Object.freeze({ revision: "0", payload: null });
      exactObject(rows[0], ["revision", "payload"], "SQLite durability state");
      return copyState({ revision: rows[0].revision, payload: rows[0].payload });
    },
  );
}

function mapMaybePromise(value, mapper) {
  return value && typeof value.then === "function" ? value.then(mapper) : mapper(value);
}

function copyState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("durability state must be an object");
  }
  const keys = Object.keys(state).sort();
  if (keys.length !== 2 || keys[0] !== "payload" || keys[1] !== "revision") {
    throw new TypeError("durability state must contain exactly payload and revision");
  }
  const revision = durabilityRevision(state.revision);
  const payload = state.payload === null ? null : requirePayload(state.payload);
  if ((revision === "0") !== (payload === null)) {
    throw new TypeError("durability state payload must be null exactly at revision zero");
  }
  return Object.freeze({ revision, payload });
}

function acquiredState(owner, state) {
  return Object.freeze({
    ownerId: owner.ownerId,
    fence: owner.fence,
    revision: state.revision,
    payload: state.payload,
  });
}

function requireId(value, kind) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`durability ${kind} ID must be a non-empty string`);
  }
  return value;
}

function requirePayload(value) {
  if (typeof value !== "string") {
    throw new TypeError("durability payload must be a string");
  }
  return value;
}

function exactRows(rows, maximum, label) {
  if (!Array.isArray(rows) || rows.length > maximum) {
    throw new TypeError(`${label} query returned an invalid row set`);
  }
}

function exactObject(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} row must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(`${label} row has an invalid shape`);
  }
}
