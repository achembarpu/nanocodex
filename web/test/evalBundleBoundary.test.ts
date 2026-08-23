import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const evals = readFileSync(new URL("../src/Evals.tsx", import.meta.url), "utf8");
const liveEvals = readFileSync(new URL("../src/LiveEvals.tsx", import.meta.url), "utf8");

test("eval analytics belongs to the static Vite graph", () => {
  assert.match(liveEvals, /import \{ EvalAnalytics \} from "\.\/EvalAnalytics"/);
  assert.doesNotMatch(`${evals}\n${liveEvals}`, /import\(|\blazy\b|preloadEvalAnalytics/);
});
