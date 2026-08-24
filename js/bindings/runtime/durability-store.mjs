const MAX_REVISION = 18_446_744_073_709_551_615n;
const MAX_REVISION_TEXT = String(MAX_REVISION);

export const sqliteDurabilitySchema = Object.freeze([
  `CREATE TABLE IF NOT EXISTS nanocodex_journal_owners (
     journal_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     fence TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS nanocodex_journals (
     journal_id TEXT PRIMARY KEY,
     revision TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS nanocodex_journal_batches (
     journal_id TEXT NOT NULL,
     revision TEXT NOT NULL,
     payload TEXT NOT NULL,
     PRIMARY KEY (journal_id, revision),
     FOREIGN KEY (journal_id) REFERENCES nanocodex_journals(journal_id)
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
  const revision = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(revision) || BigInt(revision) > MAX_REVISION) {
    throw new TypeError(`durability ${field} must be an unsigned 64-bit decimal string`);
  }
  return revision;
}

export function createMemoryDurabilityStore(journalId, initial) {
  if (typeof journalId !== "string" || !journalId.trim()) {
    throw new TypeError("durability journal ID must be a non-empty string");
  }
  let journal = copyJournal(initial ?? { revision: durabilityRevision(0n), batches: [] });
  let owner;
  const select = (selected) => {
    if (selected !== journalId) throw new Error(`unknown durability journal: ${selected}`);
  };
  return Object.freeze({
    journalId,
    load(selected) {
      select(selected);
      return journal;
    },
    acquire(selected, request) {
      select(selected);
      const ownerId = durabilityOwnerId(request?.ownerId);
      const previousFence = owner?.fence ?? durabilityFence(0n);
      if (previousFence === MAX_REVISION_TEXT) {
        throw new RangeError("in-memory durability fence overflow");
      }
      const fence = durabilityFence(BigInt(previousFence) + 1n);
      owner = Object.freeze({ ownerId, fence });
      return acquiredJournal(owner, journal);
    },
    append(selected, request) {
      select(selected);
      const ownerId = durabilityOwnerId(request?.ownerId);
      const fence = durabilityFence(request?.fence);
      if (ownerId !== owner?.ownerId || fence !== owner.fence) {
        return { status: "fenced" };
      }
      const expectedRevision = durabilityRevision(request.expectedRevision);
      if (expectedRevision !== journal.revision) {
        return { status: "conflict", actualRevision: journal.revision };
      }
      if (journal.revision === MAX_REVISION_TEXT) {
        return {
          status: "not_committed",
          message: "in-memory durability revision overflow",
        };
      }
      const revision = durabilityRevision(BigInt(journal.revision) + 1n);
      journal = Object.freeze({
        revision,
        batches: Object.freeze([...journal.batches, Object.freeze({
          revision,
          payload: request.payload,
        })]),
      });
      return { status: "appended", revision };
    },
    compact(selected, request) {
      select(selected);
      const ownerId = durabilityOwnerId(request?.ownerId);
      const fence = durabilityFence(request?.fence);
      if (ownerId !== owner?.ownerId || fence !== owner.fence) {
        return { status: "fenced" };
      }
      const expectedRevision = durabilityRevision(request.expectedRevision);
      if (expectedRevision !== journal.revision) {
        return { status: "conflict", actualRevision: journal.revision };
      }
      if (expectedRevision === "0") {
        return { status: "not_committed", message: "cannot compact an empty journal" };
      }
      journal = Object.freeze({
        revision: expectedRevision,
        batches: Object.freeze([Object.freeze({
          revision: expectedRevision,
          payload: request.payload,
        })]),
      });
      return { status: "compacted", revision: expectedRevision };
    },
    snapshot() {
      return journal;
    },
  });
}

export function createSqliteDurabilityStore(options) {
  if (!options || typeof options.transaction !== "function") {
    throw new TypeError("SQLite durability requires a transaction function");
  }
  return Object.freeze({
    load(journalId) {
      return options.transaction((query) => loadSqliteJournal(query, journalId));
    },
    acquire(journalId, request) {
      const ownerId = durabilityOwnerId(request?.ownerId);
      return options.transaction((query) => mapMaybePromise(
        query(
          "SELECT owner_id, fence FROM nanocodex_journal_owners WHERE journal_id = ?",
          [journalId],
        ),
        (owners) => {
          const previousFence = durabilityFence(owners[0]?.fence ?? "0");
          if (previousFence === MAX_REVISION_TEXT) {
            throw new RangeError("SQLite durability fence overflow");
          }
          const fence = durabilityFence(BigInt(previousFence) + 1n);
          return mapMaybePromise(
            query(
              `INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence) VALUES (?, ?, ?)
               ON CONFLICT (journal_id) DO UPDATE SET owner_id = excluded.owner_id, fence = excluded.fence`,
              [journalId, ownerId, fence],
            ),
            () => mapMaybePromise(
              loadSqliteJournal(query, journalId),
              (journal) => acquiredJournal({ ownerId, fence }, journal),
            ),
          );
        },
      ));
    },
    append(journalId, request) {
      const ownerId = durabilityOwnerId(request?.ownerId);
      const fence = durabilityFence(request?.fence);
      const expectedRevision = durabilityRevision(request.expectedRevision);
      return options.transaction((query) => mapMaybePromise(
        query(
          "SELECT owner_id, fence FROM nanocodex_journal_owners WHERE journal_id = ?",
          [journalId],
        ),
        (owners) => {
          const storedOwner = owners[0];
          if (
            storedOwner?.owner_id !== ownerId
            || durabilityFence(storedOwner?.fence ?? "0") !== fence
          ) {
            return { status: "fenced" };
          }
          return mapMaybePromise(
            query(
              "SELECT revision FROM nanocodex_journals WHERE journal_id = ?",
              [journalId],
            ),
            (journals) => {
              const actualRevision = durabilityRevision(journals[0]?.revision ?? "0");
              if (actualRevision !== expectedRevision) {
                return { status: "conflict", actualRevision };
              }
              if (expectedRevision === MAX_REVISION_TEXT) {
                return {
                  status: "not_committed",
                  message: "SQLite durability revision overflow",
                };
              }
              const revision = durabilityRevision(BigInt(expectedRevision) + 1n);
              return mapMaybePromise(
                query(
                  `INSERT INTO nanocodex_journals (journal_id, revision) VALUES (?, ?)
                   ON CONFLICT (journal_id) DO UPDATE SET revision = excluded.revision`,
                  [journalId, revision],
                ),
                () => mapMaybePromise(
                  query(
                    "INSERT INTO nanocodex_journal_batches (journal_id, revision, payload) VALUES (?, ?, ?)",
                    [journalId, revision, request.payload],
                  ),
                  () => ({ status: "appended", revision }),
                ),
              );
            },
          );
        },
      ));
    },
    compact(journalId, request) {
      const ownerId = durabilityOwnerId(request?.ownerId);
      const fence = durabilityFence(request?.fence);
      const expectedRevision = durabilityRevision(request.expectedRevision);
      return options.transaction((query) => mapMaybePromise(
        query(
          "SELECT owner_id, fence FROM nanocodex_journal_owners WHERE journal_id = ?",
          [journalId],
        ),
        (owners) => {
          const storedOwner = owners[0];
          if (
            storedOwner?.owner_id !== ownerId
            || durabilityFence(storedOwner?.fence ?? "0") !== fence
          ) {
            return { status: "fenced" };
          }
          return mapMaybePromise(
            query(
              "SELECT revision FROM nanocodex_journals WHERE journal_id = ?",
              [journalId],
            ),
            (journals) => {
              const actualRevision = durabilityRevision(journals[0]?.revision ?? "0");
              if (actualRevision !== expectedRevision) {
                return { status: "conflict", actualRevision };
              }
              if (expectedRevision === "0") {
                return {
                  status: "not_committed",
                  message: "cannot compact an empty SQLite durability journal",
                };
              }
              return mapMaybePromise(
                query(
                  "DELETE FROM nanocodex_journal_batches WHERE journal_id = ?",
                  [journalId],
                ),
                () => mapMaybePromise(
                  query(
                    "INSERT INTO nanocodex_journal_batches (journal_id, revision, payload) VALUES (?, ?, ?)",
                    [journalId, expectedRevision, request.payload],
                  ),
                  () => ({ status: "compacted", revision: expectedRevision }),
                ),
              );
            },
          );
        },
      ));
    },
  });
}

function loadSqliteJournal(query, journalId) {
  return mapMaybePromise(
    query(
      "SELECT revision FROM nanocodex_journals WHERE journal_id = ?",
      [journalId],
    ),
    (journals) => mapMaybePromise(
      query(
        `SELECT revision, payload FROM nanocodex_journal_batches
         WHERE journal_id = ? ORDER BY length(revision), revision`,
        [journalId],
      ),
      (batches) => ({
        revision: durabilityRevision(journals[0]?.revision ?? "0"),
        batches: batches.map((batch) => ({
          revision: durabilityRevision(batch.revision),
          payload: batch.payload,
        })),
      }),
    ),
  );
}

function mapMaybePromise(value, mapper) {
  return value && typeof value.then === "function" ? value.then(mapper) : mapper(value);
}

function copyJournal(journal) {
  return Object.freeze({
    revision: durabilityRevision(journal.revision),
    batches: Object.freeze(journal.batches.map((batch) => Object.freeze({
      revision: durabilityRevision(batch.revision),
      payload: batch.payload,
    }))),
  });
}

function acquiredJournal(owner, journal) {
  return Object.freeze({
    ownerId: owner.ownerId,
    fence: owner.fence,
    revision: journal.revision,
    batches: journal.batches,
  });
}

function durabilityOwnerId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("durability owner ID must be a non-empty string");
  }
  return value;
}
