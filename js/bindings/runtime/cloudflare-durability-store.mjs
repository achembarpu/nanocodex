import {
  createSqliteDurabilityStore,
  durabilityRevision,
  sqliteDurabilitySchema,
} from "./durability-store.mjs";

const ACQUIRE_PAGE_ROWS = 8;
const DIRECT_PAYLOAD_BYTES = 1_000_000;
const PAYLOAD_CHUNK_CODE_UNITS = 256_000;
const MAX_REVISION = 18_446_744_073_709_551_615n;
const encoder = new TextEncoder();

const cloudflareDurabilitySchema = Object.freeze([
  ...sqliteDurabilitySchema,
  `CREATE TABLE IF NOT EXISTS nanocodex_journal_batch_chunks (
     journal_id TEXT NOT NULL,
     revision TEXT NOT NULL,
     chunk_index INTEGER NOT NULL,
     payload TEXT NOT NULL,
     PRIMARY KEY (journal_id, revision, chunk_index),
     FOREIGN KEY (journal_id, revision)
       REFERENCES nanocodex_journal_batches(journal_id, revision)
   )`,
]);

/** Adapts one Cloudflare Durable Object's colocated SQLite to Nanocodex. */
export function createCloudflareDurabilityStore(storage) {
  if (
    !storage?.sql
    || typeof storage.sql.exec !== "function"
    || typeof storage.transactionSync !== "function"
  ) {
    throw new TypeError("Cloudflare durability requires Durable Object storage with SQLite");
  }

  for (const statement of cloudflareDurabilitySchema) storage.sql.exec(statement);
  const rawQuery = (sql, args) => {
    const cursor = storage.sql.exec(sql, ...args);
    if (typeof cursor?.[Symbol.iterator] !== "function") return cursor.toArray();
    const rows = [];
    for (const row of cursor) rows.push(row);
    return rows;
  };
  const query = (sql, args) => {
    if (sql.startsWith("INSERT INTO nanocodex_journal_batches")) {
      return insertBatch(rawQuery, sql, args);
    }
    if (sql.startsWith("DELETE FROM nanocodex_journal_batches")) {
      rawQuery(
        "DELETE FROM nanocodex_journal_batch_chunks WHERE journal_id = ?",
        [args[0]],
      );
    }
    const rows = rawQuery(sql, args);
    return sql.includes("SELECT revision, payload FROM nanocodex_journal_batches")
      ? hydrateBatchPayloads(rawQuery, args[0], rows)
      : rows;
  };
  const store = createSqliteDurabilityStore({
    transaction: (callback) => storage.transactionSync(() => callback(query)),
  });
  return Object.freeze({
    ...store,
    acquirePage(journalId, request) {
      const ownerId = request?.ownerId;
      if (typeof ownerId !== "string" || !ownerId) {
        throw new TypeError("durability owner ID must be a non-empty string");
      }
      const afterRevision = request?.afterRevision;
      if (afterRevision !== undefined) durabilityRevision(afterRevision);
      return storage.transactionSync(() => {
        let owner;
        if (afterRevision === undefined) {
          const retained = query(
            "SELECT owner_id, fence FROM nanocodex_journal_owners WHERE journal_id = ?",
            [journalId],
          )[0];
          const previousFence = BigInt(durabilityRevision(retained?.fence ?? "0"));
          if (previousFence === MAX_REVISION) {
            throw new RangeError("Cloudflare durability fence overflow");
          }
          owner = { ownerId, fence: String(previousFence + 1n) };
          query(
            `INSERT INTO nanocodex_journal_owners (journal_id, owner_id, fence) VALUES (?, ?, ?)
             ON CONFLICT (journal_id) DO UPDATE SET owner_id = excluded.owner_id, fence = excluded.fence`,
            [journalId, owner.ownerId, owner.fence],
          );
        } else {
          const retained = query(
            "SELECT owner_id, fence FROM nanocodex_journal_owners WHERE journal_id = ?",
            [journalId],
          )[0];
          if (retained?.owner_id !== ownerId) {
            throw new Error("Cloudflare durability page owner was fenced");
          }
          owner = { ownerId, fence: durabilityRevision(retained.fence) };
        }
        const journal = query(
          "SELECT revision FROM nanocodex_journals WHERE journal_id = ?",
          [journalId],
        )[0];
        const revision = durabilityRevision(journal?.revision ?? "0");
        const bindings = afterRevision === undefined
          ? [journalId]
          : [journalId, afterRevision, afterRevision, afterRevision];
        const rows = query(
          afterRevision === undefined
            ? `SELECT revision, payload FROM nanocodex_journal_batches
               WHERE journal_id = ? ORDER BY length(revision), revision LIMIT 9`
            : `SELECT revision, payload FROM nanocodex_journal_batches
               WHERE journal_id = ? AND (
                 length(revision) > length(?) OR
                 (length(revision) = length(?) AND revision > ?)
               ) ORDER BY length(revision), revision LIMIT 9`,
          bindings,
        );
        const hasMore = rows.length > ACQUIRE_PAGE_ROWS;
        if (hasMore) rows.pop();
        return {
          ...owner,
          revision,
          batches: rows,
          hasMore,
        };
      });
    },
  });
}

function insertBatch(query, sql, args) {
  const [journalId, revision, payload] = args;
  if (typeof payload !== "string") {
    throw new TypeError("durability batch payload must be a string");
  }
  if (encoder.encode(payload).byteLength <= DIRECT_PAYLOAD_BYTES) {
    return query(sql, args);
  }
  const result = query(sql, [journalId, revision, ""]);
  const chunks = payloadChunks(payload);
  for (let index = 0; index < chunks.length; index += 1) {
    query(
      `INSERT INTO nanocodex_journal_batch_chunks
         (journal_id, revision, chunk_index, payload) VALUES (?, ?, ?, ?)`,
      [journalId, revision, index, chunks[index]],
    );
  }
  return result;
}

function hydrateBatchPayloads(query, journalId, batches) {
  if (batches.length === 0) return batches;
  const selected = [...new Set(
    batches.map((batch) => durabilityRevision(batch.revision)),
  )];
  const payloads = new Map();
  for (let offset = 0; offset < selected.length; offset += 99) {
    const revisions = selected.slice(offset, offset + 99);
    const placeholders = revisions.map(() => "?").join(", ");
    const chunks = query(
      `SELECT revision, chunk_index, payload FROM nanocodex_journal_batch_chunks
       WHERE journal_id = ? AND revision IN (${placeholders})
       ORDER BY length(revision), revision, chunk_index`,
      [journalId, ...revisions],
    );
    for (const chunk of chunks) {
      const revision = durabilityRevision(chunk.revision);
      const retained = payloads.get(revision) ?? [];
      if (chunk.chunk_index !== retained.length || typeof chunk.payload !== "string") {
        throw new Error(`invalid Cloudflare durability chunks for revision ${revision}`);
      }
      retained.push(chunk.payload);
      payloads.set(revision, retained);
    }
  }
  return batches.map((batch) => {
    const chunks = payloads.get(durabilityRevision(batch.revision));
    if (chunks === undefined) {
      if (batch.payload === "") {
        throw new Error(`missing Cloudflare durability chunks for revision ${batch.revision}`);
      }
      return batch;
    }
    if (batch.payload !== "") {
      throw new Error(`invalid Cloudflare durability chunk head for revision ${batch.revision}`);
    }
    return { ...batch, payload: chunks.join("") };
  });
}

function payloadChunks(payload) {
  const chunks = [];
  for (let offset = 0; offset < payload.length;) {
    let end = Math.min(offset + PAYLOAD_CHUNK_CODE_UNITS, payload.length);
    if (
      end < payload.length
      && isHighSurrogate(payload.charCodeAt(end - 1))
      && isLowSurrogate(payload.charCodeAt(end))
    ) {
      end -= 1;
    }
    chunks.push(payload.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
