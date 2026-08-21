import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const evals = readFileSync(new URL("../src/Evals.tsx", import.meta.url), "utf8");
const liveEvals = readFileSync(new URL("../src/LiveEvals.tsx", import.meta.url), "utf8");

test("the eval overview leaves analytics behind a detail-only dynamic boundary", () => {
  assert.doesNotMatch(liveEvals, /from ["']\.\/EvalAnalytics["']/);
  assert.match(liveEvals, /import\(["']\.\/EvalAnalytics["']\)/);

  const overview = liveEvals.slice(
    liveEvals.indexOf('if (data.kind === "overview")'),
    liveEvals.indexOf('if (data.kind === "workset")'),
  );
  assert.doesNotMatch(overview, /<Analytics/);

  const routeDispatch = evals.slice(evals.indexOf("function EvalsContent"));
  const overviewDispatch = routeDispatch.slice(
    0,
    routeDispatch.indexOf('if (route.kind === "workset")'),
  );
  assert.doesNotMatch(overviewDispatch, /preloadEvalAnalytics\(\)/);
  assert.match(
    routeDispatch,
    /route\.kind === "workset"[\s\S]*?preloadEvalAnalytics\(\)/,
  );
  assert.match(
    routeDispatch,
    /route\.kind === "task"[\s\S]*?preloadEvalAnalytics\(\)/,
  );
});
