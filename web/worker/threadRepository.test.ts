import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ThreadGitRepository,
  isThreadRepository,
  type ThreadRepository,
} from "./threadRepository.ts";

const head = "a".repeat(40);

test("thread repository state accepts only the nanocodex branch and scoped pack keys", () => {
  assert.equal(isThreadRepository(repository()), true);
  assert.equal(isThreadRepository({ ...repository(), branch: "main" }), false);
  assert.equal(isThreadRepository({ ...repository(), packKey: "../escape.pack" }), false);
});

test("receive leases serialize and atomically replace thread refs", async () => {
  const values = new Map<string, unknown>();
  const state = {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key),
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  } as unknown as DurableObjectState;
  const durable = new ThreadGitRepository(state);

  const first = await durable.fetch(new Request("https://repository.test/receive/begin", { method: "POST" }));
  assert.equal(first.status, 200);
  const busy = await durable.fetch(new Request("https://repository.test/receive/begin", { method: "POST" }));
  assert.equal(busy.status, 409);
  const token = ((await first.json()) as { lease: { token: string } }).lease.token;
  const finalized = await durable.fetch(new Request("https://repository.test/receive/finalize", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, repository: repository() }),
  }));
  assert.equal(finalized.status, 200);
  const current = await durable.fetch(new Request("https://repository.test/thread"));
  assert.deepEqual(await current.json(), repository());
});

function repository(): ThreadRepository {
  return {
    version: 1,
    branch: "nanocodex",
    head,
    refs: [{ name: "refs/heads/nanocodex", oid: head }],
    packKey: "thread-repositories/thread-12345678-1234-4123-8123-123456789abc/pack.pack",
    packHash: "b".repeat(40),
    packSize: 123,
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}
