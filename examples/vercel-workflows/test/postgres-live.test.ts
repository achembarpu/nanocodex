import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  DurabilityImportConflictError,
  durabilityRevision,
  exportDurabilityState,
  importDurabilityState,
} from "nanocodex/durability";
import { createPostgresDurabilityStore } from "nanocodex/durability/postgres";

const live = process.env.NANOCODEX_LIVE_POSTGRES === "1";
const connectionString = process.env.DATABASE_URL;
const schemaA = `nanocodex_live_a_${randomUUID().replaceAll("-", "")}`;
const schemaB = `nanocodex_live_b_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let sourcePool: Pool;
let destinationPool: Pool;

describe.runIf(live)("live PostgreSQL durability", () => {
  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required for live PostgreSQL tests");
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schemaA}`);
    await admin.query(`CREATE SCHEMA ${schemaB}`);
    sourcePool = new Pool({ connectionString, options: `-c search_path=${schemaA}` });
    destinationPool = new Pool({ connectionString, options: `-c search_path=${schemaB}` });
  });

  afterAll(async () => {
    await Promise.allSettled([sourcePool?.end(), destinationPool?.end()]);
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaA} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaB} CASCADE`);
      await admin.end();
    }
  });

  it("uses real pg.Pool transactions for fencing, CAS, and portable import", async () => {
    const stateId = `live-postgres-${randomUUID()}`;
    const source = createPostgresDurabilityStore(sourcePool);
    const owner = await source.acquire(stateId, { ownerId: "live-owner" });
    const contenders = await Promise.all(Array.from({ length: 24 }, (_, index) => (
      createPostgresDurabilityStore(sourcePool).replace(stateId, {
        ownerId: owner.ownerId,
        fence: owner.fence,
        expectedRevision: owner.revision,
        payload: `winner-${index}`,
      })
    )));
    expect(contenders.filter(({ status }) => status === "replaced")).toHaveLength(1);
    expect(contenders.filter(({ status }) => status === "conflict")).toHaveLength(23);

    const retained = await source.load(stateId);
    expect(retained).toMatchObject({ revision: durabilityRevision("1") });
    const archive = JSON.parse(JSON.stringify(
      await exportDurabilityState(source, stateId),
    ));
    const destination = createPostgresDurabilityStore(destinationPool);
    await expect(importDurabilityState(destination, archive)).resolves.toEqual(retained);
    await expect(importDurabilityState(destination, archive)).rejects.toBeInstanceOf(
      DurabilityImportConflictError,
    );

    const reopened = await destination.acquire(stateId, { ownerId: "vercel-workflow-step" });
    expect(reopened).toMatchObject(retained);
    await expect(destination.replace(stateId, {
      ownerId: reopened.ownerId,
      fence: reopened.fence,
      expectedRevision: reopened.revision,
      payload: `${retained.payload}:continued-on-vercel`,
    })).resolves.toEqual({ status: "replaced", revision: durabilityRevision("2") });
    await expect(source.replace(stateId, {
      ownerId: owner.ownerId,
      fence: owner.fence,
      expectedRevision: durabilityRevision("1"),
      payload: "stale-source-resurrection",
    })).resolves.toEqual({ status: "fenced" });
  });
});
