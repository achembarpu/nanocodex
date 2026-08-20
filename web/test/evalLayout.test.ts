import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/evals.css", import.meta.url), "utf8");
const analytics = readFileSync(new URL("../src/EvalAnalytics.tsx", import.meta.url), "utf8");

test("the eval shell uses the full-width layout and resolved header height", () => {
  assert.match(css, /\.live-evals \{[^}]*width:\s*100%/);
  assert.doesNotMatch(css, /\.live-evals \{[^}]*width:\s*min\(/);
  assert.match(css, /100svh - var\(--shell-header-height\)/);
});

test("compact eval controls retain evidence and mobile interaction baselines", () => {
  assert.doesNotMatch(css, /eval-progress-copy span:last-child/);
  assert.match(css, /\.live-eval-search input \{ font-size: 16px; \}/);
  assert.match(css, /\.live-filter button \{ min-height: 44px; \}/);
  assert.match(css, /\.eval-task-matrix th:first-child \{[\s\S]*?position: sticky/);
});

test("eval status animation honors reduced motion", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none/);
});

test("chart identity and colors remain stable across API point order and themes", () => {
  assert.match(analytics, /function paletteColor\(key: string\)/);
  assert.match(analytics, /paletteColor\(line\.key\)/);
  assert.doesNotMatch(analytics, /palette\[index/);
  assert.match(css, /html\[data-theme="dark"\] \.live-evals/);
  assert.match(css, /--eval-series-6:/);
});
