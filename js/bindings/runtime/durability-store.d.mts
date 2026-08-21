export type {
  DurabilityAppendRequest,
  DurabilityAppendResult,
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
  value: string | bigint,
): import("../types.mjs").DurabilityRevision;

export declare function createMemoryDurabilityStore(
  journalId: string,
  initial?: import("../types.mjs").DurabilityStoredJournal,
): import("../types.mjs").MemoryDurabilityStore;

export declare function createSqliteDurabilityStore(
  options: import("../types.mjs").SqliteDurabilityStoreOptions,
): import("../types.mjs").DurabilityStore;
