import type { DurabilityStore } from "../types.mjs";

/** A PostgreSQL result row. Column values remain owned by the pool implementation. */
export type PostgresDurabilityRow = Readonly<Record<string, unknown>>;

/** The only query result shape read by the PostgreSQL durability adapter. */
export type PostgresDurabilityQueryResult<
  Row extends PostgresDurabilityRow = PostgresDurabilityRow,
> = Readonly<{
  rows: readonly Row[];
}>;

/**
 * A dedicated PostgreSQL connection held for one transaction.
 *
 * `release(true)` asks a node-postgres-compatible pool to discard a connection
 * whose transaction state or COMMIT outcome cannot be trusted.
 */
export type PostgresDurabilityClient = Readonly<{
  query<Row extends PostgresDurabilityRow = PostgresDurabilityRow>(
    text: string,
    values?: unknown[] | undefined,
  ): PromiseLike<PostgresDurabilityQueryResult<Row>>;
  release(discard?: boolean | Error | undefined): void;
}>;

/**
 * Minimal structural PostgreSQL pool capability consumed by the adapter.
 *
 * This is intentionally compatible with `pg.Pool` without importing `pg` or
 * owning its lifecycle. `connect()` must reserve one client until `release()`,
 * while `query()` executes a standalone load query through the pool.
 */
export type PostgresDurabilityPool = Readonly<{
  connect(): PromiseLike<PostgresDurabilityClient>;
  query<Row extends PostgresDurabilityRow = PostgresDurabilityRow>(
    text: string,
    values?: unknown[] | undefined,
  ): PromiseLike<PostgresDurabilityQueryResult<Row>>;
}>;

/**
 * Signals that PostgreSQL may have applied COMMIT before the connection failed.
 *
 * Callers must treat this as an unknown write outcome and reload the journal;
 * it is never converted to the definite `not_committed` append result.
 */
export declare class UnknownPostgresCommitOutcomeError extends Error {
  override readonly name: "UnknownPostgresCommitOutcomeError";
  constructor(journalId: string, cause: unknown);
}

/**
 * Creates a concrete PostgreSQL-backed Nanocodex durability store.
 *
 * The schema is initialized lazily under a PostgreSQL transaction advisory
 * lock. Loads preserve numeric revision order. Appends atomically compare and
 * advance the journal head before inserting the opaque batch in one
 * transaction. Failures return `not_committed` only when no transaction began
 * or ROLLBACK was confirmed; a failed COMMIT throws
 * {@link UnknownPostgresCommitOutcomeError} instead.
 *
 * The supplied pool is structural and caller-owned. Constructing the store
 * does not connect, query, or import a PostgreSQL driver.
 */
export declare function createPostgresDurabilityStore(
  pool: PostgresDurabilityPool,
): DurabilityStore;
