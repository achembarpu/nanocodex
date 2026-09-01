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

test("task snapshots use one request and one coordinate read", async () => {
  const statements: string[] = [];
  let coordinateReads = 0;
  const metadata = {
    workset_id: 7,
    profile: "terminal-bench",
    workset_digest: "workset-digest",
    created_at_ms: 1_700_000_000_000,
    workset_task_count: 12,
    workset_total: 20,
    workset_unclaimed: 2,
    workset_running: 1,
    workset_success: 16,
    workset_failed: 1,
    task_id: 9,
    public_id: "task-public",
    name: "terminal-bench/fix-git",
    task_digest: "task-digest",
    treatment_count: 1,
    task_total: 2,
    task_unclaimed: 0,
    task_running: 0,
    task_success: 1,
    task_failed: 1,
  };
  const coordinates = [
    {
      id: 1,
      public_id: "coordinate-1",
      task_public_id: "task-public",
      task_name: "terminal-bench/fix-git",
      task_digest: "task-digest",
      family_key: "nanocodex-gpt-high",
      harness: "nanocodex",
      model: "gpt-5",
      thinking: "high",
      repetition: 1,
      state: "success",
      started_at_ms: 100,
      finished_at_ms: 180,
      error: null,
      case_key: "cases/workset/coordinate-1.json",
      status: "passed",
      outcome: "passed",
      input_tokens: 1000,
      cached_input_tokens: 500,
      output_tokens: 120,
      reasoning_output_tokens: 80,
      total_tokens: 1120,
      cost_usd: 0.02,
      agent_duration_ms: 80,
    },
  ];
  const env = {
    EVALS_DB: {
      prepare(sql: string) {
        statements.push(sql);
        if (sql.includes("task_rows AS MATERIALIZED")) {
          return {
            bind() {
              return { async first() { return metadata; } };
            },
          };
        }
        assert.match(sql, /FROM eval_tasks e JOIN task_definitions d/);
        coordinateReads += 1;
        return {
          bind() {
            return { async all() { return { results: coordinates }; } };
          },
        };
      },
    } as unknown as D1Database,
    EVALS_ARTIFACTS: {} as R2Bucket,
  };
  const url = new URL(
    "https://nanocodex.test/api/evals/worksets/workset-digest/tasks/task-public",
  );

  const response = await routeEvalRead(new Request(url), env, url);
  const body = await response?.json() as Record<string, any>;

  assert.equal(response?.status, 200);
  assert.equal(statements.length, 2);
  assert.equal(coordinateReads, 1);
  assert.equal(body.schemaVersion, 5);
  assert.equal(body.workset.summary.running, 1);
  assert.equal(body.taskSummary.summary.success, 1);
  assert.equal(body.task.treatments[0].cells[0].detailId, "coordinate-1");
  assert.equal(body.points[0].outputTokens, 120);

  const retired = new URL(`${url}/results`);
  const retiredResponse = await routeEvalRead(new Request(retired), env, retired);
  assert.equal(retiredResponse?.status, 404);
  assert.equal(statements.length, 2);
});
