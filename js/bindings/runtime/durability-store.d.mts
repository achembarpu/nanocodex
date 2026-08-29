export type {
  DurabilityAcquiredState,
  DurabilityAcquireRequest,
  DurabilityReplaceRequest,
  DurabilityReplaceResult,
  DurabilityFence,
  DurabilityRevision,
  DurabilitySqliteQuery,
  DurabilitySqliteRow,
  DurabilitySqliteTransaction,
  DurabilitySqliteValue,
  DurabilityStore,
  DurabilityStoredState,
  MemoryDurabilityStore,
  SqliteDurabilityStoreOptions,
} from "../types.mjs";

export declare const sqliteDurabilitySchema: readonly string[];

export declare function durabilityRevision(
  /** Numbers must be nonnegative safe integers; use exact decimal text for larger values. */
  value: string | bigint | number,
): import("../types.mjs").DurabilityRevision;

export declare function createMemoryDurabilityStore(
  stateId: string,
  initial?: import("../types.mjs").DurabilityStoredState,
): import("../types.mjs").MemoryDurabilityStore;

export declare function createSqliteDurabilityStore(
  options: import("../types.mjs").SqliteDurabilityStoreOptions,
): import("../types.mjs").DurabilityStore;
