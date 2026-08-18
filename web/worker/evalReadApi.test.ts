import assert from "node:assert/strict";
import { test } from "node:test";

import { routeEvalRead } from "./evalReadApi.ts";

test("task packages are public immutable R2 reads", async () => {
  const bytes = new TextEncoder().encode("task-package");
  const env = {
    EVALS_DB: {} as D1Database,
    EVALS_ARTIFACTS: {
      async get(key: string) {
        assert.equal(key, "tasks/workset/task.tar.zst");
        return {
          body: new Blob([bytes]).stream(),
          size: bytes.byteLength,
          httpEtag: '"task-etag"',
        };
      },
    } as unknown as R2Bucket,
  };
  const url = new URL(
    "https://nanocodex.test/v1/task-package?key=tasks%2Fworkset%2Ftask.tar.zst",
  );

  const response = await routeEvalRead(new Request(url), env, url);

  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "task-package");
  assert.equal(response?.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response?.headers.get("content-type"), "application/x-tar+zstd");
});

test("immutable eval artifacts populate and hit the edge cache", async () => {
  const originalCaches = globalThis.caches;
  const entries = new Map<string, Response>();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async (request: Request) => entries.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          entries.set(request.url, response.clone());
        },
      },
    },
  });
  let objectReads = 0;
  const env = {
    EVALS_DB: {} as D1Database,
    EVALS_ARTIFACTS: {
      async get() {
        objectReads += 1;
        const bytes = new TextEncoder().encode("cached-package");
        return {
          body: new Blob([bytes]).stream(),
          size: bytes.byteLength,
          httpEtag: '"cached"',
        };
      },
    } as unknown as R2Bucket,
  };
  const url = new URL("https://nanocodex.test/v1/task-package?key=tasks%2Fcached.tar.zst");
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as ExecutionContext;

  try {
    assert.equal((await routeEvalRead(new Request(url), env, url, context))?.status, 200);
    await Promise.all(pending);
    assert.equal((await routeEvalRead(new Request(url), env, url, context))?.status, 200);
    assert.equal(objectReads, 1);
  } finally {
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: originalCaches,
    });
  }
});

test("task package reads cannot escape the task object prefix", async () => {
  const env = {
    EVALS_DB: {} as D1Database,
    EVALS_ARTIFACTS: {} as R2Bucket,
  };
  const url = new URL(
    "https://nanocodex.test/v1/task-package?key=attempts%2Fworkset%2Fevidence.tar.zst",
  );

  const response = await routeEvalRead(new Request(url), env, url);

  assert.equal(response?.status, 400);
});

test("status is scoped to a requested profile and rejects a missing board", async () => {
  let boundProfile = "";
  const env = {
    EVALS_DB: {
      prepare(sql: string) {
        assert.match(sql, /WHERE w\.state = 'ready' AND w\.profile = \?1/);
        assert.match(sql, /eval_tasks e ON e\.definition_id = d\.id/);
        return {
          bind(profile: string) {
            boundProfile = profile;
            return { async first() { return null; } };
          },
        };
      },
    } as unknown as D1Database,
    EVALS_ARTIFACTS: {} as R2Bucket,
  };
  const url = new URL("https://nanocodex.test/v1/status?profile=tb21-full-cmo-k5");

  const response = await routeEvalRead(new Request(url), env, url);

  assert.equal(boundProfile, "tb21-full-cmo-k5");
  assert.equal(response?.status, 404);
  assert.deepEqual(await response?.json(), { error: "evaluation profile was not found" });
});
