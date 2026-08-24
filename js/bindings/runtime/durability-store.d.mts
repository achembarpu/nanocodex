export type {
  DurabilityAcquiredJournal,
  DurabilityAcquireRequest,
  DurabilityAppendRequest,
  DurabilityAppendResult,
  DurabilityCompactRequest,
  DurabilityCompactResult,
  DurabilityFence,
  DurabilityRevision,
  DurabilitySqliteQuery,
  DurabilitySqliteRow,
  DurabilitySqliteTransaction,
  DurabilitySqliteValue,
  DurabilityStore,
  DurabilityStoredBatch,
  DurabilityStoredJournal,
  MemoryDurabilityStore,
  SqliteDurabilityStoreOptions,
} from "../types.mjs";

export declare const sqliteDurabilitySchema: readonly string[];

export declare function durabilityRevision(
  /** Numbers must be nonnegative safe integers; use exact decimal text for larger values. */
  value: string | bigint | number,
): import("../types.mjs").DurabilityRevision;

export declare function createMemoryDurabilityStore(
  journalId: string,
  initial?: import("../types.mjs").DurabilityStoredJournal,
): import("../types.mjs").MemoryDurabilityStore;

export declare function createSqliteDurabilityStore(
  options: import("../types.mjs").SqliteDurabilityStoreOptions,
): import("../types.mjs").DurabilityStore;
