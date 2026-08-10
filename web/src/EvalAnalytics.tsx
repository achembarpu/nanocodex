import { memo, useMemo } from "react";
import {
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { EvalResultPoint } from "./evalApi";

type AxisKey = "output" | "latency" | "cost";
type RunAxisKey = "input" | "latency" | "cost";
type ChartPoint = {
  x: number;
  score: number;
  effort: string;
  harness: string;
  model: string;
  passed: number;
  completed: number;
  sample: number;
};
type Series = {
  key: string;
  name: string;
  harness: string;
  values: ChartPoint[];
};
type RunChartPoint = {
  id: string;
  repetition: number;
  outputTokens: number;
  value: number;
  harness: string;
  model: string;
  thinking: string;
  result: string;
  passed: boolean;
};
type RunSeries = {
  key: string;
  name: string;
  color: string;
  passed: boolean;
  values: RunChartPoint[];
};
type RunLegendItem = {
  key: string;
  label: string;
  color: string;
};

const effortOrder = ["low", "medium", "high", "xhigh"];
const palette = ["#0a82e1", "#7557d9", "#e57522", "#d53b3b", "#128342", "#9b6b13"];
const harnessColors: Record<string, string> = {
  codex: "#0a82e1",
  nanocodex: "#e57522",
};
const runColors: Record<string, Record<string, string>> = {
  codex: {
    low: "#74b9f0",
    medium: "#258fe5",
    high: "#0968bd",
    xhigh: "#5946c5",
  },
  nanocodex: {
    low: "#f5a866",
    medium: "#e57522",
    high: "#c55319",
    xhigh: "#9e2f32",
  },
};

function harnessLabel(harness: string) {
  if (harness === "codex") return "Codex";
  if (harness === "nanocodex") return "Nanocodex";
  return harness;
}

function runColor(harness: string, thinking: string) {
  return runColors[harness]?.[thinking] ?? harnessColors[harness] ?? "#7557d9";
}

function effortRank(effort: string) {
  const rank = effortOrder.indexOf(effort);
  return rank < 0 ? effortOrder.length : rank;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const metrics = {
  output: {
    title: "Score by output tokens",
    label: "Median output tokens",
    runTitle: "Output tokens by run",
    runLabel: "Output tokens",
    value: (point: EvalResultPoint) => point.outputTokens,
    tick: (value: number) => Intl.NumberFormat(undefined, { notation: "compact" }).format(value),
  },
  latency: {
    title: "Score by elapsed time",
    label: "Median elapsed time",
    runTitle: "Elapsed time by run",
    runLabel: "Elapsed time",
    value: (point: EvalResultPoint) => point.durationMs,
    tick: (value: number) => value < 60_000 ? `${Math.round(value / 1_000)}s` : `${(value / 60_000).toFixed(1)}m`,
  },
  cost: {
    title: "Score by cost",
    label: "Median cost",
    runTitle: "Cost by run",
    runLabel: "Cost",
    value: (point: EvalResultPoint) => point.costUsd,
    tick: (value: number) => `$${value < 0.01 ? value.toFixed(3) : value.toFixed(2)}`,
  },
} satisfies Record<AxisKey, {
  title: string;
  label: string;
  runTitle: string;
  runLabel: string;
  value: (point: EvalResultPoint) => number | null;
  tick: (value: number) => string;
}>;

const runMetrics = {
  input: {
    title: "Input vs output tokens",
    label: "Input tokens",
    value: (point: EvalResultPoint) => point.inputTokens,
    tick: (value: number) => Intl.NumberFormat(undefined, { notation: "compact" }).format(value),
  },
  latency: {
    title: "Elapsed time vs output tokens",
    label: "Elapsed time",
    value: (point: EvalResultPoint) => point.durationMs,
    tick: metrics.latency.tick,
  },
  cost: {
    title: "Cost vs output tokens",
    label: "Cost",
    value: (point: EvalResultPoint) => point.costUsd,
    tick: metrics.cost.tick,
  },
} satisfies Record<RunAxisKey, {
  title: string;
  label: string;
  value: (point: EvalResultPoint) => number | null;
  tick: (value: number) => string;
}>;

function passed(point: EvalResultPoint) {
  return point.status === "passed" || point.outcome === "passed";
}

function seriesFor(points: EvalResultPoint[], axisKey: AxisKey): Series[] {
  const axis = metrics[axisKey];
  const grouped = new Map<string, EvalResultPoint[]>();
  for (const point of points) {
    const key = `${point.harness}\u0000${point.model}\u0000${point.thinking}`;
    const group = grouped.get(key) ?? [];
    group.push(point);
    grouped.set(key, group);
  }
  const lines = new Map<string, ChartPoint[]>();
  for (const group of grouped.values()) {
    const first = group[0];
    const values = group.flatMap((point) => {
      const value = axis.value(point);
      return value === null ? [] : [value];
    });
    const x = median(values);
    if (x === null) continue;
    const key = `${first.harness}\u0000${first.model}`;
    const line = lines.get(key) ?? [];
    line.push({
      x,
      score: group.filter(passed).length / group.length * 100,
      effort: first.thinking,
      harness: first.harness,
      model: first.model,
      passed: group.filter(passed).length,
      completed: group.length,
      sample: values.length,
    });
    lines.set(key, line);
  }
  return [...lines.entries()].map(([key, values]) => ({
    key,
    name: key.split("\u0000").join(" · "),
    harness: values[0]?.harness ?? "",
    values: values.sort((left, right) => {
      const leftRank = effortOrder.indexOf(left.effort);
      const rightRank = effortOrder.indexOf(right.effort);
      return (leftRank < 0 ? 99 : leftRank) - (rightRank < 0 ? 99 : rightRank);
    }),
  }));
}

function runSeriesFor(points: EvalResultPoint[], axisKey: RunAxisKey): RunSeries[] {
  const axis = runMetrics[axisKey];
  const grouped = new Map<string, RunSeries>();
  for (const point of points) {
    const value = axis.value(point);
    if (value === null || point.outputTokens === null) continue;
    const didPass = passed(point);
    const key = `${point.harness}\u0000${point.thinking}\u0000${didPass ? "passed" : "failed"}`;
    const series = grouped.get(key) ?? {
      key,
      name: `${harnessLabel(point.harness)} · ${point.thinking} · ${didPass ? "passed" : "failed"}`,
      color: runColor(point.harness, point.thinking),
      passed: didPass,
      values: [],
    };
    series.values.push({
      id: point.id,
      repetition: point.repetition,
      outputTokens: point.outputTokens,
      value,
      harness: point.harness,
      model: point.model,
      thinking: point.thinking,
      result: point.status ?? point.outcome ?? "unknown",
      passed: didPass,
    });
    grouped.set(key, series);
  }
  return [...grouped.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function runLegendFor(points: EvalResultPoint[]): RunLegendItem[] {
  const items = new Map<string, RunLegendItem>();
  for (const point of points) {
    const key = `${point.harness}\u0000${point.thinking}`;
    if (!items.has(key)) {
      items.set(key, {
        key,
        label: `${harnessLabel(point.harness)} · ${point.thinking}`,
        color: runColor(point.harness, point.thinking),
      });
    }
  }
  return [...items.values()].sort((left, right) => {
    const [leftHarness, leftEffort] = left.key.split("\u0000");
    const [rightHarness, rightEffort] = right.key.split("\u0000");
    return leftHarness.localeCompare(rightHarness)
      || effortRank(leftEffort) - effortRank(rightEffort)
      || leftEffort.localeCompare(rightEffort);
  });
}

function ChartTooltip({
  active,
  payload,
  axis,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  axis: (typeof metrics)[AxisKey];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as ChartPoint | undefined;
  if (!point) return null;
  return (
    <div className="eval-chart-tooltip">
      <strong>{harnessLabel(point.harness)} · {point.model}</strong>
      <span>{point.effort} thinking</span>
      <span>{Math.round(point.score)}% · {point.passed}/{point.completed} passed</span>
      <span>{axis.label}: {axis.tick(point.x)} · median of {point.sample}</span>
    </div>
  );
}

function FrontierChart({ points, axisKey }: { points: EvalResultPoint[]; axisKey: AxisKey }) {
  const axis = metrics[axisKey];
  const series = useMemo(() => seriesFor(points, axisKey), [axisKey, points]);
  return (
    <article className="eval-frontier">
      <header><h3>{axis.title}</h3><p>Thinking effort increases along each line.</p></header>
      {series.length ? (
        <div className="eval-chart-canvas">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 12, right: 24, bottom: 46, left: 18 }} accessibilityLayer>
              <XAxis
                type="number"
                dataKey="x"
                domain={[0, "auto"]}
                tickFormatter={axis.tick}
                label={{ value: axis.label, position: "insideBottom", offset: -32 }}
              />
              <YAxis
                type="number"
                dataKey="score"
                domain={[0, 100]}
                width={48}
                tickFormatter={(value) => `${value}%`}
              />
              <Tooltip content={({ active, payload }) => (
                <ChartTooltip active={active} payload={payload} axis={axis} />
              )} />
              <Legend verticalAlign="top" align="right" iconType="line" />
              {series.map((line, index) => {
                const color = palette[index % palette.length];
                return (
                  <Scatter
                    key={line.key}
                    name={line.name}
                    data={line.values}
                    fill={color}
                    line={{ stroke: color, strokeWidth: 2.5 }}
                    isAnimationActive={false}
                  />
                );
              })}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="eval-chart-empty">
          <strong>No retained {axis.label.toLowerCase()} points yet.</strong>
          <span>This chart fills as completed runs are indexed.</span>
        </div>
      )}
    </article>
  );
}

function RunTooltip({
  active,
  payload,
  axis,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  axis: (typeof runMetrics)[RunAxisKey];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as RunChartPoint | undefined;
  if (!point) return null;
  return (
    <div className="eval-chart-tooltip">
      <strong>{point.harness} · {point.model}</strong>
      <span>{point.thinking} thinking · k={point.repetition}</span>
      <span>{point.passed ? "○ passed" : "× failed"} · {point.result}</span>
      <span>Output tokens: {metrics.output.tick(point.outputTokens)}</span>
      <span>{axis.label}: {axis.tick(point.value)}</span>
    </div>
  );
}

function RunChart({ points, axisKey }: { points: EvalResultPoint[]; axisKey: RunAxisKey }) {
  const axis = runMetrics[axisKey];
  const series = useMemo(() => runSeriesFor(points, axisKey), [axisKey, points]);
  return (
    <article className="eval-frontier eval-run-chart">
      <header><h3>{axis.title}</h3><p>One mark per retained treatment run.</p></header>
      {series.length ? (
        <div className="eval-chart-canvas">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 12, right: 24, bottom: 46, left: 24 }} accessibilityLayer>
              <XAxis
                type="number"
                dataKey="outputTokens"
                domain={[0, "auto"]}
                tickFormatter={metrics.output.tick}
                label={{ value: "Output tokens", position: "insideBottom", offset: -32 }}
              />
              <YAxis
                type="number"
                dataKey="value"
                domain={[0, "auto"]}
                width={64}
                tickFormatter={axis.tick}
              />
              <ZAxis range={[70, 70]} />
              <Tooltip content={({ active, payload }) => (
                <RunTooltip active={active} payload={payload} axis={axis} />
              )} />
              {series.map((runSeries) => (
                <Scatter
                  key={runSeries.key}
                  name={runSeries.name}
                  data={runSeries.values}
                  fill={runSeries.color}
                  isAnimationActive={false}
                  shape={({ cx, cy }) => runSeries.passed ? (
                    <circle cx={cx} cy={cy} r={5} fill="none" stroke={runSeries.color} strokeWidth={2} />
                  ) : (
                    <g stroke={runSeries.color} strokeWidth={2} strokeLinecap="round">
                      <line x1={(cx ?? 0) - 5} y1={(cy ?? 0) - 5} x2={(cx ?? 0) + 5} y2={(cy ?? 0) + 5} />
                      <line x1={(cx ?? 0) + 5} y1={(cy ?? 0) - 5} x2={(cx ?? 0) - 5} y2={(cy ?? 0) + 5} />
                    </g>
                  )}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="eval-chart-empty">
          <strong>No retained {axis.label.toLowerCase()} points yet.</strong>
          <span>This chart fills as this task completes runs.</span>
        </div>
      )}
    </article>
  );
}

export const EvalAnalytics = memo(function EvalAnalytics({
  points,
  view = "frontier",
}: {
  points: EvalResultPoint[];
  view?: "frontier" | "runs";
}) {
  const taskCount = new Set(points.map((point) => point.taskId)).size;
  const passedCount = points.filter(passed).length;
  const runView = view === "runs";
  const runLegend = useMemo(() => runLegendFor(points), [points]);
  return (
    <section className="eval-artifact" aria-labelledby="eval-artifact-title">
      <header className="eval-artifact-head">
        <div>
          <p className="rail-label">{runView ? "Task evidence" : "Benchmark artifact"}</p>
          <h2 id="eval-artifact-title">{runView ? "Runs" : "Score frontiers"}</h2>
          <p>{runView
            ? "Actual retained runs positioned by output-token volume. Circle means pass; × means failure."
            : "Codex and Nanocodex across model and thinking effort, using medians over retained repetitions."}</p>
          {runView ? (
            <div className="eval-run-legend" aria-label="Run chart legend">
              {runLegend.map((item) => (
                <span key={item.key}><i style={{ backgroundColor: item.color }} /> {item.label}</span>
              ))}
              <span><b>○</b> pass</span>
              <span><b>×</b> failure</span>
            </div>
          ) : null}
        </div>
        <dl>
          <div><dt>Runs</dt><dd>{points.length}</dd></div>
          <div><dt>{runView ? "Failed" : "Tasks"}</dt><dd>{runView ? points.length - passedCount : taskCount}</dd></div>
          <div><dt>Passed</dt><dd>{passedCount}</dd></div>
        </dl>
      </header>
      <div className="eval-chart-grid">
        {runView ? (
          <>
            <RunChart points={points} axisKey="input" />
            <RunChart points={points} axisKey="latency" />
            <RunChart points={points} axisKey="cost" />
          </>
        ) : (
          <>
            <FrontierChart points={points} axisKey="output" />
            <FrontierChart points={points} axisKey="latency" />
            <FrontierChart points={points} axisKey="cost" />
          </>
        )}
      </div>
    </section>
  );
});
