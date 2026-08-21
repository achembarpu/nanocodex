import {
  createSqliteDurabilityStore,
  sqliteDurabilitySchema,
} from "./durability-store.mjs";

/** Adapts one Cloudflare Durable Object's colocated SQLite to Nanocodex. */
export function createCloudflareDurabilityStore(storage) {
  if (
    !storage?.sql
    || typeof storage.sql.exec !== "function"
    || typeof storage.transactionSync !== "function"
  ) {
    throw new TypeError("Cloudflare durability requires Durable Object storage with SQLite");
  }

  for (const statement of sqliteDurabilitySchema) storage.sql.exec(statement);
  const query = (sql, args) => storage.sql.exec(sql, ...args).toArray();
  return createSqliteDurabilityStore({
    transaction: (callback) => storage.transactionSync(() => callback(query)),
  });
}
