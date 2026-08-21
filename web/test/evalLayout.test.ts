import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/evals.css", import.meta.url), "utf8");
const analytics = readFileSync(new URL("../src/EvalAnalytics.tsx", import.meta.url), "utf8");
const evals = readFileSync(new URL("../src/LiveEvals.tsx", import.meta.url), "utf8");

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
  assert.match(css, /\(pointer: coarse\) and \(orientation: landscape\) and \(max-width: 950px\)/);
  assert.match(css, /@media \(pointer: coarse\), \(any-pointer: coarse\)/);
  assert.match(css, /\.eval-freshness button,[\s\S]*?min-height: 44px/);
});

test("charts lead retained evidence while operational cluster detail stays last", () => {
  const overview = evals.slice(evals.indexOf('if (data.kind === "overview")'), evals.indexOf('if (data.kind === "workset")'));
  assert.ok(overview.indexOf('id="worksets-heading"') < overview.indexOf("<ClusterView"));
  const workset = evals.slice(evals.indexOf('if (data.kind === "workset")'), evals.indexOf("const taskWorkset"));
  assert.ok(workset.indexOf("<Analytics") < workset.indexOf('id="tasks-heading"'));
  const task = evals.slice(evals.indexOf("const taskWorkset"));
  assert.ok(task.indexOf('<Analytics points={data.snapshot.points}') < task.indexOf('id="treatments-heading"'));
  assert.match(overview, /All retained evaluations progress/);
});

test("chart and operational empty states remain explicit", () => {
  assert.match(analytics, /No retained \{axis\.label\.toLowerCase\(\)\} points yet/);
  assert.match(evals, /No durable worksets yet/);
  assert.match(evals, /No tasks match this filter/);
  assert.match(evals, /No cluster nodes are reporting/);
});

test("eval status animation honors reduced motion", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none/);
});

test("chart identity and colors remain stable across API point order and themes", () => {
  assert.match(analytics, /function paletteColor\(key: string\)/);
  assert.match(analytics, /paletteColor\(line\.key\)/);
  assert.doesNotMatch(analytics, /palette\[index/);
  assert.doesNotMatch(css, /--eval-series-\d:\s*#/);
  assert.match(css, /--eval-series-2:\s*color-mix\(in srgb, var\(--text\)/);
  assert.match(css, /--eval-series-6:/);
  assert.match(css, /\.eval-progress-track \.success \{ background: var\(--positive\)/);
  assert.match(css, /\.eval-progress-track \.failed \{ background: var\(--negative\)/);
});
