const MAX_REVISION = 18_446_744_073_709_551_615n;
const MAX_REVISION_TEXT = String(MAX_REVISION);

export const sqliteDurabilitySchema = Object.freeze([
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
  const revision = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(revision) || BigInt(revision) > MAX_REVISION) {
    throw new TypeError("durability revision must be an unsigned 64-bit decimal string");
  }
  return revision;
}

export function createMemoryDurabilityStore(journalId, initial) {
  if (typeof journalId !== "string" || !journalId.trim()) {
    throw new TypeError("durability journal ID must be a non-empty string");
  }
  let journal = copyJournal(initial ?? { revision: durabilityRevision(0n), batches: [] });
  const select = (selected) => {
    if (selected !== journalId) throw new Error(`unknown durability journal: ${selected}`);
  };
  return Object.freeze({
    journalId,
    load(selected) {
      select(selected);
      return journal;
    },
    append(selected, request) {
      select(selected);
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
      return options.transaction((query) => mapMaybePromise(
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
      ));
    },
    append(journalId, request) {
      const expectedRevision = durabilityRevision(request.expectedRevision);
      return options.transaction((query) => mapMaybePromise(
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
      ));
    },
  });
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
