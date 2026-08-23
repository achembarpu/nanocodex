import type {
  DurabilitySqliteRow,
  DurabilitySqliteValue,
  DurabilityStore,
} from "../types.mjs";

export type CloudflareDurableObjectStorage = Readonly<{
  sql: Readonly<{
    exec<Row extends DurabilitySqliteRow>(
      sql: string,
      ...bindings: readonly DurabilitySqliteValue[]
    ): Readonly<{ toArray(): readonly Row[] }>;
  }>;
  transactionSync<Result>(callback: () => Result): Result;
}>;

/**
 * Initializes and adapts one Durable Object's colocated SQLite journal.
 * Rust owns every opaque batch; the host only provides atomic storage.
 */
export declare function createCloudflareDurabilityStore(
  storage: CloudflareDurableObjectStorage,
): DurabilityStore;
