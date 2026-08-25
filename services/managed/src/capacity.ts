import type { ManagedEventArchiveCapacity } from "./managed-event-archive";
import type { ManagedRealtimeArchiveCapacity } from "./managed-realtime-archive";
import type { ManagedTurnArchiveCapacity } from "./managed-turn-archive";

type CountAndBytes = Readonly<{
  bytes: number;
  rows: number;
}>;

export type ManagedCapacitySnapshot = Readonly<{
  archived_events: ManagedEventArchiveCapacity;
  archived_realtime: ManagedRealtimeArchiveCapacity;
  archived_turns: ManagedTurnArchiveCapacity;
  database_size_bytes: number;
  journal: CountAndBytes & Readonly<{
    max_batch_bytes: number;
    revision: string;
  }>;
  known_payload_bytes: number;
  managed_events: CountAndBytes;
  raw_events: CountAndBytes;
  realtime_operations: CountAndBytes;
  turns: Readonly<{
    blocked_rows: number;
    input_bytes: number;
    terminal_bytes: number;
    terminal_rows: number;
    total_rows: number;
    unfinished_rows: number;
  }>;
  unattributed_database_bytes: number;
}>;

type AggregateRow = {
  bytes: number;
  rows: number;
};

type JournalRow = AggregateRow & {
  max_batch_bytes: number;
  revision: string;
};

type TurnRow = {
  blocked_rows: number;
  input_bytes: number;
  terminal_bytes: number;
  terminal_rows: number;
  total_rows: number;
  unfinished_rows: number;
};

const EMPTY_AGGREGATE: CountAndBytes = Object.freeze({ bytes: 0, rows: 0 });

/**
 * Accounts for the content-bearing tables owned by one managed Agent DO.
 *
 * `unattributed_database_bytes` intentionally includes SQLite indexes/pages,
 * workspace state, and any future tables. That remainder makes schema growth
 * visible without coupling this diagnostic to Computer's private schema.
 */
export function managedCapacitySnapshot(
  storage: DurableObjectStorage,
  sessionId: string,
  archivedEvents: ManagedEventArchiveCapacity,
  archivedTurns: ManagedTurnArchiveCapacity,
  archivedRealtime: ManagedRealtimeArchiveCapacity,
): ManagedCapacitySnapshot {
  const journal = journalCapacity(storage, cloudflareJournalId(storage, sessionId));
  const managedEvents = eventCapacity(storage, "managed_events", "message_json");
  const rawEvents = eventCapacity(
    storage,
    "nanocodex_cloudflare_events",
    "event_json",
  );
  const realtimeOperations = eventCapacity(
    storage,
    "managed_realtime_operations",
    "response_json",
  );
  const turns = turnCapacity(storage);
  const knownPayloadBytes = journal.bytes
    + managedEvents.bytes
    + rawEvents.bytes
    + realtimeOperations.bytes
    + turns.input_bytes
    + turns.terminal_bytes;
  const databaseSizeBytes = storage.sql.databaseSize;

  return {
    archived_events: archivedEvents,
    archived_realtime: archivedRealtime,
    archived_turns: archivedTurns,
    database_size_bytes: databaseSizeBytes,
    journal,
    known_payload_bytes: knownPayloadBytes,
    managed_events: managedEvents,
    raw_events: rawEvents,
    realtime_operations: realtimeOperations,
    turns,
    unattributed_database_bytes: Math.max(0, databaseSizeBytes - knownPayloadBytes),
  };
}

function cloudflareJournalId(storage: DurableObjectStorage, fallbackSessionId: string): string {
  if (!tableExists(storage, "nanocodex_cloudflare_agent")) {
    return `cloudflare:${fallbackSessionId}`;
  }
  const runtimeSessionId = storage.sql.exec<{ session_id: string }>(
    "SELECT session_id FROM nanocodex_cloudflare_agent WHERE singleton = 1",
  ).toArray()[0]?.session_id;
  return `cloudflare:${runtimeSessionId ?? fallbackSessionId}`;
}

function journalCapacity(
  storage: DurableObjectStorage,
  journalId: string,
): ManagedCapacitySnapshot["journal"] {
  if (!tableExists(storage, "nanocodex_journal_batches")) {
    return { ...EMPTY_AGGREGATE, max_batch_bytes: 0, revision: "0" };
  }
  return storage.sql.exec<JournalRow>(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS bytes,
            COALESCE(MAX(LENGTH(CAST(payload AS BLOB))), 0) AS max_batch_bytes,
            COALESCE((SELECT revision FROM nanocodex_journals WHERE journal_id = ?), '0') AS revision
     FROM nanocodex_journal_batches
     WHERE journal_id = ?`,
    journalId,
    journalId,
  ).toArray()[0] ?? { ...EMPTY_AGGREGATE, max_batch_bytes: 0, revision: "0" };
}

function eventCapacity(
  storage: DurableObjectStorage,
  table: "managed_events" | "managed_realtime_operations" | "nanocodex_cloudflare_events",
  column: "event_json" | "message_json" | "response_json",
): CountAndBytes {
  if (!tableExists(storage, table)) return EMPTY_AGGREGATE;
  return storage.sql.exec<AggregateRow>(
    `SELECT COUNT(*) AS rows,
            COALESCE(SUM(LENGTH(CAST(${column} AS BLOB))), 0) AS bytes
     FROM ${table}`,
  ).toArray()[0] ?? EMPTY_AGGREGATE;
}

function turnCapacity(storage: DurableObjectStorage): ManagedCapacitySnapshot["turns"] {
  if (!tableExists(storage, "managed_turns")) {
    return {
      blocked_rows: 0,
      input_bytes: 0,
      terminal_bytes: 0,
      terminal_rows: 0,
      total_rows: 0,
      unfinished_rows: 0,
    };
  }
  return storage.sql.exec<TurnRow>(
    `SELECT COUNT(*) AS total_rows,
            COALESCE(SUM(LENGTH(CAST(input_json AS BLOB))), 0) AS input_bytes,
            COALESCE(SUM(LENGTH(CAST(terminal_json AS BLOB))), 0) AS terminal_bytes,
            SUM(CASE WHEN state IN ('completed', 'cancelled', 'failed') THEN 1 ELSE 0 END)
              AS terminal_rows,
            SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked_rows,
            SUM(CASE WHEN state NOT IN ('completed', 'cancelled', 'failed', 'blocked') THEN 1 ELSE 0 END)
              AS unfinished_rows
     FROM managed_turns`,
  ).toArray()[0] ?? {
    blocked_rows: 0,
    input_bytes: 0,
    terminal_bytes: 0,
    terminal_rows: 0,
    total_rows: 0,
    unfinished_rows: 0,
  };
}

function tableExists(storage: DurableObjectStorage, table: string): boolean {
  return storage.sql.exec<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    table,
  ).toArray().length > 0;
}
