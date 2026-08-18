import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GitRepository,
  isRepositoryPublication,
  type RepositoryPublication,
} from "./gitRepository.ts";

const firstHash = "a".repeat(40);
const secondHash = "b".repeat(40);

test("publication validation pins every mutable view to one generation", () => {
  assert.equal(isRepositoryPublication(publication(firstHash)), true);
  assert.equal(isRepositoryPublication({
    ...publication(firstHash),
    packKey: `generations/${secondHash}/repository.pack`,
  }), false);
  assert.equal(isRepositoryPublication({
    ...publication(firstHash),
    refs: [{ name: "refs/heads/../escape", oid: firstHash }],
  }), false);
});

test("publication uses compare-and-swap so stale mirrors cannot win", async () => {
  const values = new Map<string, unknown>();
  const state = {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  } as unknown as DurableObjectState;
  const repository = new GitRepository(state);

  const first = await repository.fetch(publishRequest(null, publication(firstHash)));
  assert.equal(first.status, 200);
  const stale = await repository.fetch(publishRequest(null, publication(secondHash)));
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: "publication_conflict",
    currentHead: firstHash,
  });
  const second = await repository.fetch(publishRequest(firstHash, publication(secondHash)));
  assert.equal(second.status, 200);
  const current = await repository.fetch(new Request("https://repository.test/publication"));
  assert.equal((await current.json() as RepositoryPublication).head, secondHash);
});

function publication(head: string): RepositoryPublication {
  const prefix = `generations/${head}/`;
  return {
    version: 1,
    head,
    branch: "master",
    refs: [{ name: "refs/heads/master", oid: head }],
    snapshotKey: `${prefix}repository.json`,
    commitsKey: `${prefix}commits.json`,
    inventoryKey: `${prefix}inventory.json`,
    packKey: `${prefix}repository.pack`,
    objectManifestKey: `${prefix}objects.json`,
    packHash: "c".repeat(40),
    publishedAt: "2026-08-17T00:00:00.000Z",
  };
}

function publishRequest(expectedHead: string | null, value: RepositoryPublication): Request {
  return new Request("https://repository.test/publication", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedHead, publication: value }),
  });
}
