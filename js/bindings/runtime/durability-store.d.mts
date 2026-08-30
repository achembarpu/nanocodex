export type {
  DurabilityAcquiredState,
  DurabilityAcquireRequest,
  DurabilityReplaceRequest,
  DurabilityReplaceResult,
  DurabilityFence,
  DurabilityPortableStateArchive,
  DurabilityPortableStore,
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

export declare class DurabilityImportConflictError extends Error {
  override readonly name: "DurabilityImportConflictError";
  constructor(stateId: string);
}

export declare function durabilityRevision(
  /** Numbers must be nonnegative safe integers; use exact decimal text for larger values. */
  value: string | bigint | number,
): import("../types.mjs").DurabilityRevision;

/**
 * Atomically fences the source owner and exports one coherent JSON-safe state.
 * Do not resume the source provider after beginning a cutover.
 */
export declare function exportDurabilityState(
  store: import("../types.mjs").DurabilityStore,
  stateId: string,
): Promise<import("../types.mjs").DurabilityPortableStateArchive>;

/** Restores an exact archive and its stable state identity into an empty destination. */
export declare function importDurabilityState(
  store: import("../types.mjs").DurabilityPortableStore,
  archive: import("../types.mjs").DurabilityPortableStateArchive,
): Promise<import("../types.mjs").DurabilityStoredState>;

export declare function createMemoryDurabilityStore(
  stateId: string,
  initial?: import("../types.mjs").DurabilityStoredState,
): import("../types.mjs").MemoryDurabilityStore;

export declare function createSqliteDurabilityStore(
  options: import("../types.mjs").SqliteDurabilityStoreOptions,
): import("../types.mjs").DurabilityPortableStore;
