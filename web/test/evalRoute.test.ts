import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evalRouteFromPath } from "../src/evalRoute.ts";

const evalsSource = source("../src/Evals.tsx");
const liveEvalsSource = source("../src/LiveEvals.tsx");
const appSource = source("../src/NanocodexApp.tsx");
const entrySource = source("../src/main.tsx");

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
  assert.match(appSource, /if \(nextSurface === "evals"\) preloadEvalOverview\(\)/);
  assert.doesNotMatch(appSource, /<Suspense/);
  assert.match(
    entrySource,
    /<Suspense fallback=\{null\}>\s*<NanocodexApp preparedRoute=\{preparedRoute\} \/>/,
  );
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
  assert.match(appSource, /<main id="top">/);
});

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function matches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}
