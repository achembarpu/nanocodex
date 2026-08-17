export * as Actions from "./actions/index.mjs";
export function durabilityRevision(value) {
  const revision = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(revision)) {
    throw new TypeError("durability revision must be an unsigned decimal string");
  }
  return revision;
}
export function subscriptionRevision(value) {
  const revision = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(revision)) {
    throw new TypeError("subscription revision must be an unsigned decimal string");
  }
  return revision;
}

export function createMemoryChatGptSubscriptionStore(id, initial) {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError("subscription ID must be a non-empty string");
  }
  let stored = Object.freeze({
    revision: subscriptionRevision(initial?.revision ?? 0n),
    ...(initial?.payload === undefined ? {} : { payload: initial.payload }),
  });
  const select = (selected) => {
    if (selected !== id) throw new Error(`unknown ChatGPT subscription: ${selected}`);
  };
  return Object.freeze({
    id,
    load(selected) {
      select(selected);
      return stored;
    },
    compareAndSwap(selected, request) {
      select(selected);
      if (request.expectedRevision !== stored.revision) {
        return { status: "conflict", actualRevision: stored.revision };
      }
      const revision = subscriptionRevision(BigInt(stored.revision) + 1n);
      stored = Object.freeze({ revision, payload: request.payload });
      return { status: "committed", revision };
    },
    snapshot() {
      return stored;
    },
  });
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
      if (request.expectedRevision !== journal.revision) {
        return { status: "conflict", actualRevision: journal.revision };
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
          "SELECT revision FROM durability_journals WHERE journal_id = ?",
          [journalId],
        ),
        (journals) => mapMaybePromise(
          query(
            `SELECT revision, payload FROM durability_batches
             WHERE journal_id = ? ORDER BY rowid`,
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
      return options.transaction((query) => mapMaybePromise(
        query(
          "SELECT revision FROM durability_journals WHERE journal_id = ?",
          [journalId],
        ),
        (journals) => {
          const actualRevision = durabilityRevision(journals[0]?.revision ?? "0");
          if (actualRevision !== request.expectedRevision) {
            return { status: "conflict", actualRevision };
          }
          const revision = durabilityRevision(BigInt(request.expectedRevision) + 1n);
          return mapMaybePromise(
            query(
              `INSERT INTO durability_journals (journal_id, revision) VALUES (?, ?)
               ON CONFLICT (journal_id) DO UPDATE SET revision = excluded.revision`,
              [journalId, revision],
            ),
            () => mapMaybePromise(
              query(
                "INSERT INTO durability_batches (journal_id, revision, payload) VALUES (?, ?, ?)",
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
export { createQuickJsEvaluator } from "./runtime/quickjs-evaluator.mjs";
export {
  createTempoProvider,
  createTempoProviderFromAccounts,
  DEFAULT_MERCATOR_MCP_URL,
} from "./runtime/tempo-provider.mjs";
