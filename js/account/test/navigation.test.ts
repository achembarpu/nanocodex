import assert from "node:assert/strict";
import test from "node:test";

import {
  commitPreparationMatchesIntent,
  settleRepositoryNavigationIntent,
} from "../src/commitRouteState.ts";
import { pathForCommit, pathForSurface, surfaceFromUrl } from "../src/navigation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("maps every Nanocodex surface to a stable route", () => {
  assert.deepEqual(
    ["home", "agent", "tools", "multiplayer", "world", "changelog", "docs", "code", "commits", "requests", "evals"].map((surface) => [
      surface,
      pathForSurface(surface as Parameters<typeof pathForSurface>[0]),
    ]),
    [
      ["home", "/"],
      ["agent", "/agent"],
      ["tools", "/agent?demo=attached-tools"],
      ["multiplayer", "/multiplayer"],
      ["world", "/world"],
      ["changelog", "/changelog"],
      ["docs", "/docs"],
      ["code", "/code"],
      ["commits", "/commits"],
      ["requests", "/requests"],
      ["evals", "/evals"],
    ],
  );
});

test("resolves direct routes and legacy view links", () => {
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/evals")), "evals");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/evals/worksets/demo/tasks/task")), "evals");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/code/")), "code");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/agent?demo=attached-tools")), "tools");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/docs/core/owned-agent")), "docs");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/?view=commits")), "commits");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/unknown")), "home");
});

test("commit deep links stay inside the product", () => {
  const hash = "a".repeat(40);
  assert.equal(pathForCommit(hash), `/commits?commit=${hash}`);
});

test("only the latest deferred navigation may commit", async () => {
  const source = deferred<string>();
  const commits = deferred<string>();
  const transitions: string[] = [];
  let latestNavigationId = 1;

  const staleSource = settleRepositoryNavigationIntent({
    navigationId: 1,
    latestNavigationId: () => latestNavigationId,
    preparation: source.promise,
    onPrepared: (snapshot) => transitions.push(`commit:${snapshot}`),
    onFailure: () => transitions.push("failure:source"),
    navigate: () => transitions.push("navigate:source"),
  });

  latestNavigationId = 2;
  const currentCommits = settleRepositoryNavigationIntent({
    navigationId: 2,
    latestNavigationId: () => latestNavigationId,
    preparation: commits.promise,
    onPrepared: (snapshot) => transitions.push(`commit:${snapshot}`),
    onFailure: () => transitions.push("failure:commits"),
    navigate: () => transitions.push("navigate:commits"),
  });
  commits.resolve("history");
  assert.equal(await currentCommits, "ready");

  source.resolve("snapshot");
  assert.equal(await staleSource, "stale");
  assert.deepEqual(transitions, ["commit:history", "navigate:commits"]);

  const failed = deferred<string>();
  latestNavigationId = 3;
  const currentFailure = settleRepositoryNavigationIntent({
    navigationId: 3,
    latestNavigationId: () => latestNavigationId,
    preparation: failed.promise,
    onPrepared: (snapshot) => transitions.push(`commit:${snapshot}`),
    onFailure: () => transitions.push("failure:repository"),
    navigate: () => transitions.push("navigate:error"),
  });
  failed.reject(new Error("repository unavailable"));
  assert.equal(await currentFailure, "failed");
  assert.deepEqual(transitions.slice(-2), ["failure:repository", "navigate:error"]);
});

test("exact commit preparation stays authoritative and plain history targets HEAD", () => {
  const exact = "a".repeat(40);
  assert.equal(commitPreparationMatchesIntent(exact, exact), true);
  assert.equal(commitPreparationMatchesIntent(undefined, undefined), true);
  assert.equal(commitPreparationMatchesIntent(undefined, exact), false);
  assert.equal(commitPreparationMatchesIntent(exact, undefined), false);
});
