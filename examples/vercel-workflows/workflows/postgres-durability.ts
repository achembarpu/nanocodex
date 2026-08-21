import { attachDatabasePool } from "@vercel/functions";
import type { DurabilityStore } from "nanocodex/durability";
import { createPostgresDurabilityStore } from "nanocodex/durability/postgres";
import { Pool } from "pg";

let applicationStore: DurabilityStore | undefined;

/** The one application-owned store used by every Vercel Workflow step. */
export function postgresDurabilityStore(): DurabilityStore {
  if (applicationStore) return applicationStore;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured; attach a Vercel Marketplace Postgres database");
  }

  const pool = new Pool({ connectionString });
  attachDatabasePool(pool);
  applicationStore = createPostgresDurabilityStore(pool);
  return applicationStore;
}
