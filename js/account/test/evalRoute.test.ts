import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryObserver } from "@tanstack/react-query";
import { createEvalQueryClient } from "../src/evalQueryClient.ts";
import { evalRouteFromPath } from "../src/evalRoute.ts";

const evalsSource = source("../src/Evals.tsx");
const evalQueryClientSource = source("../src/evalQueryClient.ts");
const liveEvalsSource = source("../src/LiveEvals.tsx");
const appSource = source("../src/NanocodexApp.tsx");
const entrySource = source("../src/main.tsx");
const routeLoadersSource = source("../src/routeLoaders.ts");

test("every hosted Evals subview has an exact typed route", () => {
  assert.deepEqual(evalRouteFromPath("/evals"), { kind: "overview" });
  assert.deepEqual(evalRouteFromPath("/evals/"), { kind: "overview" });
  assert.deepEqual(evalRouteFromPath("/evals/worksets/frontier%20suite"), {
    kind: "workset",
    worksetId: "frontier suite",
  });
  assert.deepEqual(
    evalRouteFromPath("/evals/worksets/frontier%20suite/tasks/fix%2Fgit"),
    { kind: "task", worksetId: "frontier suite", taskId: "fix/git" },
  );
});

test("unknown and malformed Evals paths never start a partial data surface", () => {
  for (const pathname of [
    "/evals/worksets",
    "/evals/worksets/frontier/tasks",
    "/evals/worksets/%E0%A4%A",
    "/evals/worksets/frontier/tasks/%E0%A4%A",
    "/evals/other/frontier",
  ]) {
    assert.deepEqual(evalRouteFromPath(pathname), { kind: "unknown" }, pathname);
  }
});

test("Evals route data is fetched in parallel and committed through one Suspense boundary", () => {
  assert.equal(matches(evalsSource, /useSuspenseQueries\s*\(/g), 2);
  assert.equal(matches(evalsSource, /useSuspenseQuery\s*\(/g), 1);
  assert.match(evalsSource, /const pathname = useDeferredValue\(location\.pathname\)/);
  assert.doesNotMatch(evalsSource, /isPending|Loading|aria-busy|fallback=/);
  assert.match(appSource, /nextSurface === "evals"[\s\S]*?preloadEvalOverview\(\)/);
  assert.match(
    routeLoadersSource,
    /surface === "evals" && url\.pathname\.replace[\s\S]*?=== "\/evals"[\s\S]*?preloadEvalOverview\(\)/,
  );
  assert.match(
    evalsSource,
    /preloadEvalOverview[\s\S]*?overviewQueryOptions\(\)[\s\S]*?prefetchQuery\(overview\)[\s\S]*?prefetchQuery\(cluster\)/,
  );
  assert.match(
    evalsSource,
    /function OverviewRoute[\s\S]*?queries: overviewQueryOptions\(\)/,
  );
  assert.match(
    entrySource,
    /<Suspense fallback=\{null\}>/,
  );
  assert.doesNotMatch(appSource, /<Suspense/);
  assert.doesNotMatch(appSource, /Loading evals/);
});

test("task routes own one coherent snapshot query and pause polling while hidden", () => {
  const taskRoute = evalsSource.slice(
    evalsSource.indexOf("function TaskRoute"),
    evalsSource.indexOf("function UnknownRoute"),
  );
  assert.equal(matches(taskRoute, /queryKey:/g), 1);
  assert.match(taskRoute, /snapshot: taskQuery\.data/);
  assert.match(taskRoute, /refetchIntervalInBackground: false/);
  assert.doesNotMatch(taskRoute, /taskResults|task-results|worksetQuery|resultsQuery/);
  assert.doesNotMatch(liveEvalsSource, /data\.results/);
});

test("refetch failures retain complete data and expose an explicit retry", () => {
  assert.match(evalsSource, /isRefetchError/);
  assert.match(liveEvalsSource, /Refresh failed/);
  assert.match(liveEvalsSource, /<button type="button" onClick=\{status\.retry\}>Retry<\/button>/);
  assert.doesNotMatch(liveEvalsSource, /Loading|spinner|skeleton|aria-busy/);
});

test("permanent Eval API client errors are not retried behind a blank route", () => {
  assert.match(
    evalQueryClientSource,
    /error instanceof EvalApiError[\s\S]*?error\.status >= 400[\s\S]*?error\.status < 500[\s\S]*?error\.status !== 408[\s\S]*?error\.status !== 425[\s\S]*?error\.status !== 429[\s\S]*?return false/,
  );
  assert.doesNotMatch(`${evalsSource}\n${evalQueryClientSource}`, /retryOnMount: false/);
});

test("resetting a failed Evals boundary remounts and refetches cached error state", async () => {
  const client = createEvalQueryClient();
  let attempts = 0;
  const options = {
    queryKey: ["evals", "retry-regression"] as const,
    queryFn: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary eval outage");
      return "recovered";
    },
    retry: false,
  };
  const first = new QueryObserver(client, options);
  await observerResult(first, (result) => result.isError);

  const remounted = new QueryObserver(client, options);
  const recovered = await observerResult(remounted, (result) => result.isSuccess);
  assert.equal(recovered.data, "recovered");
  assert.equal(attempts, 2, "the remount performs a real retry instead of rethrowing cached error state");
  client.clear();
});

test("case evidence replaces the inspector only after the request completes", () => {
  const request = liveEvalsSource.indexOf("queryClient.fetchQuery");
  const commit = liveEvalsSource.indexOf("setSelectedCell({ treatment, cell, evidence })");
  assert.ok(request >= 0);
  assert.ok(commit > request);
  assert.doesNotMatch(liveEvalsSource, /detail\.isPending|detail\.data/);
});

test("Evals keeps the application main as the only main landmark", () => {
  assert.doesNotMatch(evalsSource, /<main\b/);
  assert.doesNotMatch(liveEvalsSource, /<main\b/);
  assert.match(appSource, /<main[\s\S]*?id="top"/);
});

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function matches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}

function observerResult<T>(
  observer: QueryObserver<T>,
  predicate: (result: ReturnType<QueryObserver<T>["getCurrentResult"]>) => boolean,
): Promise<ReturnType<QueryObserver<T>["getCurrentResult"]>> {
  return new Promise((resolve) => {
    const unsubscribe = observer.subscribe((result) => {
      if (!predicate(result)) return;
      unsubscribe();
      resolve(result);
    });
  });
}
