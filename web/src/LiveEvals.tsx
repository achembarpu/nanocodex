import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Radio,
  Search,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useMatch, useNavigate } from "react-router";
import {
  evalApi,
  type EvalCase,
  type EvalCoordinate,
  type EvalOverview,
  type EvalResultPoint,
  type EvalSummary,
  type EvalTask,
  type EvalTaskOverview,
  type EvalTreatment,
  type EvalWorkset,
  type EvalWorksetResults,
} from "./evalApi";
import "./evals.css";

const EvalAnalytics = lazy(() =>
  import("./EvalAnalytics").then((module) => ({ default: module.EvalAnalytics })),
);

type MatrixFilter = "all" | "active" | "issues" | "complete";
type AnalyticsView = "frontier" | "runs";

const resultStaleMs = 30_000;
const resultCacheMs = 30 * 60_000;
const taskStaleMs = 30_000;
const resultKey = (worksetId: string | null, taskId: string | null) =>
  ["evals", "results", worksetId, taskId] as const;
const taskKey = (worksetId: string | null, taskId: string | null) =>
  ["evals", "task", worksetId, taskId] as const;

export function useEvalOverview() {
  return useQuery({
    queryKey: ["evals", "overview"],
    queryFn: ({ signal }) => evalApi.overview(signal),
    refetchInterval: 500,
    refetchIntervalInBackground: true,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    staleTime: 0,
  });
}

function formatDuration(milliseconds: number | null) {
  if (milliseconds === null) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatWorksetDate(milliseconds: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(milliseconds));
}

function formatInteger(value: unknown) {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function taskMatchesFilter(task: EvalTaskOverview, filter: MatrixFilter) {
  const { summary } = task;
  if (filter === "all") return true;
  if (filter === "active") return summary.running > 0;
  if (filter === "issues") return summary.failed > 0;
  return summary.total > 0 && summary.success + summary.failed === summary.total;
}

function coordinateLabel(cell: EvalCoordinate) {
  if (cell.state !== "success") return cell.state;
  return cell.status ?? cell.outcome ?? "success";
}

function CellMark({ cell }: { cell: EvalCoordinate }) {
  const label = coordinateLabel(cell);
  return (
    <span className={`eval-cell-mark ${label}`} aria-hidden="true">
      {label === "passed" ? "✓" : label === "failed" ? "×" : cell.repetition}
    </span>
  );
}

function JsonEvidence({ title, value }: { title: string; value: unknown }) {
  if (!value) return null;
  return (
    <details className="live-evidence-block">
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function CaseInspector({
  detailId,
  cell,
  treatment,
  onClose,
}: {
  detailId: string;
  cell: EvalCoordinate;
  treatment: EvalTreatment;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ["evals", "case", detailId],
    queryFn: ({ signal }) => evalApi.evalCase(detailId, signal),
    staleTime: Infinity,
  });
  const evidence: EvalCase | undefined = detail.data;
  return (
    <article className={`live-case-detail ${cell.state}`} aria-label="Selected evaluation case">
      <header>
        <div>
          <p className="eyebrow">{treatment.harness} · {treatment.model} · {treatment.thinking}</p>
          <h2>Repetition {cell.repetition}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close case detail">
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="live-case-detail-status">
        <strong>{evidence?.status ?? coordinateLabel(cell)}</strong>
        <span>{formatDuration(cell.durationMs)}</span>
      </div>
      {detail.isPending ? <p className="live-case-loading">Loading retained case evidence…</p> : null}
      {detail.error ? <p className="live-case-error"><AlertTriangle aria-hidden="true" /> {detail.error.message}</p> : null}
      {evidence ? (
        <>
          <dl className="live-case-metrics">
            <div><dt>Model</dt><dd>{evidence.model ?? treatment.model}</dd></div>
            <div><dt>Effort</dt><dd>{evidence.effort ?? treatment.thinking}</dd></div>
            <div><dt>Environment</dt><dd>{evidence.environment ?? "—"}</dd></div>
            <div><dt>Tool calls</dt><dd>{formatInteger(evidence.toolCalls)}</dd></div>
            <div><dt>Input tokens</dt><dd>{formatInteger(evidence.usage?.input_tokens)}</dd></div>
            <div><dt>Cached input</dt><dd>{formatInteger(evidence.usage?.cached_input_tokens)}</dd></div>
            <div><dt>Output tokens</dt><dd>{formatInteger(evidence.usage?.output_tokens)}</dd></div>
            <div><dt>Total tokens</dt><dd>{formatInteger(evidence.usage?.total_tokens)}</dd></div>
          </dl>
          {evidence.prompt ? (
            <section className="live-case-task">
              <p className="rail-label">Task instruction</p>
              <pre>{evidence.prompt}</pre>
            </section>
          ) : null}
          {evidence.verifierStdout ? (
            <details className="live-evidence-block" open={evidence.status !== "passed"}>
              <summary>Verifier stdout</summary>
              <pre>{evidence.verifierStdout}</pre>
            </details>
          ) : null}
          {evidence.verifierStderr ? (
            <details className="live-evidence-block" open>
              <summary>Verifier stderr</summary>
              <pre>{evidence.verifierStderr}</pre>
            </details>
          ) : null}
          {evidence.finalMessage ? (
            <details className="live-evidence-block">
              <summary>Final agent message</summary>
              <pre>{evidence.finalMessage}</pre>
            </details>
          ) : null}
          <JsonEvidence title="Verifier result" value={evidence.verifier} />
          <JsonEvidence title="Exception" value={evidence.exception} />
          <JsonEvidence title="Timing" value={evidence.timing} />
        </>
      ) : null}
    </article>
  );
}

function health(summary: EvalSummary) {
  if (summary.failed > 0) {
    return { status: "degraded", message: `${summary.failed} execution failure(s) retained with evidence.` };
  }
  if (summary.success === summary.total) {
    return { status: "healthy", message: "Every durable task finished execution." };
  }
  return { status: "healthy", message: "The durable ledger is progressing." };
}

function progressRank(summary: EvalSummary) {
  if (summary.running > 0) return 0;
  if (summary.unclaimed > 0) return 1;
  return 2;
}

function ProgressBar({ summary, label }: { summary: EvalSummary; label: string }) {
  const denominator = Math.max(summary.total, 1);
  const finished = summary.success + summary.failed;
  const segments = [
    { key: "success", value: summary.success },
    { key: "failed", value: summary.failed },
    { key: "running", value: summary.running },
    { key: "unclaimed", value: summary.unclaimed },
  ];
  return (
    <div
      className="eval-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={summary.total}
      aria-valuenow={finished}
    >
      <div className="eval-progress-track">
        {segments.map((segment) => segment.value > 0 ? (
          <span
            className={segment.key}
            style={{ width: `${segment.value / denominator * 100}%` }}
            key={segment.key}
          />
        ) : null)}
      </div>
      <div className="eval-progress-copy">
        <strong>{finished} / {summary.total}</strong>
        <span>{summary.running} running</span>
        <span>{summary.unclaimed} unclaimed</span>
        {summary.failed > 0 ? <span>{summary.failed} execution failed</span> : null}
      </div>
    </div>
  );
}

function PageBack({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" className="eval-back" onClick={onClick}>
      <ChevronLeft aria-hidden="true" />
      {children}
    </button>
  );
}

function Analytics({ points, view = "frontier" }: { points: EvalResultPoint[]; view?: AnalyticsView }) {
  return (
    <Suspense fallback={<section className="eval-chart-loading"><CircleDashed aria-hidden="true" /><span>Loading charts…</span></section>}>
      <EvalAnalytics points={points} view={view} />
    </Suspense>
  );
}

export function LiveEvals({ overview }: { overview: EvalOverview }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const taskRoute = useMatch("/evals/worksets/:worksetId/tasks/:taskId");
  const worksetRoute = useMatch("/evals/worksets/:worksetId");
  const route = taskRoute ?? worksetRoute;
  const [selectedCell, setSelectedCell] = useState<{
    treatment: EvalTreatment;
    cell: EvalCoordinate;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MatrixFilter>("all");
  const detailRef = useRef<HTMLDivElement>(null);
  const selectedWorkset = route?.params.worksetId
    ? overview.worksets.find((workset) => workset.id === route.params.worksetId) ?? null
    : null;
  const worksetQuery = useQuery({
    queryKey: ["evals", "workset", selectedWorkset?.id],
    enabled: Boolean(selectedWorkset),
    queryFn: ({ signal }) => evalApi.workset(selectedWorkset!.id, signal),
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
  });
  const tasks = worksetQuery.data?.tasks ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleTasks = useMemo(
    () => tasks
      .filter(
        (task) =>
          (!normalizedQuery ||
            task.name.toLowerCase().includes(normalizedQuery) ||
            task.label.toLowerCase().includes(normalizedQuery)) &&
          taskMatchesFilter(task, filter),
      )
      .sort((left, right) =>
        progressRank(left.summary) - progressRank(right.summary) || left.name.localeCompare(right.name)
      ),
    [filter, normalizedQuery, tasks],
  );
  const orderedWorksets = useMemo(
    () => [...overview.worksets].sort((left, right) =>
      progressRank(left.summary) - progressRank(right.summary) ||
      right.createdAtMs - left.createdAtMs
    ),
    [overview.worksets],
  );
  const selectedTaskId = taskRoute?.params.taskId ?? null;
  const selectedTaskOverview = selectedTaskId
    ? tasks.find((task) => task.id === selectedTaskId) ?? null
    : null;
  const taskQuery = useQuery({
    queryKey: taskKey(selectedWorkset?.id ?? null, selectedTaskId),
    enabled: Boolean(selectedWorkset && selectedTaskId),
    queryFn: ({ signal }) =>
      evalApi.task(selectedWorkset!.id, selectedTaskId!, signal),
    refetchInterval:
      selectedTaskOverview &&
      selectedTaskOverview.summary.total > 0 &&
      selectedTaskOverview.summary.success + selectedTaskOverview.summary.failed === selectedTaskOverview.summary.total
        ? false
        : 15_000,
    refetchIntervalInBackground: true,
    staleTime: taskStaleMs,
    gcTime: resultCacheMs,
    refetchOnWindowFocus: false,
  });
  const resultsSummary = selectedTaskOverview?.summary ?? selectedWorkset?.summary;
  const resultsQuery = useQuery<EvalWorksetResults>({
    queryKey: resultKey(selectedWorkset?.id ?? null, selectedTaskId),
    enabled: Boolean(selectedWorkset && (!taskRoute || selectedTaskId)),
    queryFn: ({ signal }) => selectedTaskId
      ? evalApi.taskResults(selectedWorkset!.id, selectedTaskId, signal)
      : evalApi.worksetResults(selectedWorkset!.id, signal),
    placeholderData: () => {
      if (!selectedWorkset || !selectedTaskId) return undefined;
      const worksetResults = queryClient.getQueryData<EvalWorksetResults>(
        resultKey(selectedWorkset.id, null),
      );
      return worksetResults ? {
        ...worksetResults,
        points: worksetResults.points.filter((point) => point.taskId === selectedTaskId),
      } : undefined;
    },
    refetchInterval: resultsSummary && resultsSummary.success + resultsSummary.failed < resultsSummary.total
      ? 15_000
      : false,
    staleTime: resultStaleMs,
    gcTime: resultCacheMs,
    refetchOnWindowFocus: false,
  });
  const selectedTask: EvalTask | null = taskQuery.data?.task ?? null;
  const repetitions = [
    ...new Set(selectedTask?.treatments.flatMap((treatment) =>
      treatment.cells.map((cell) => cell.repetition)) ?? []),
  ].sort((left, right) => left - right);
  const currentHealth = health(overview.summary);

  useEffect(() => {
    if (!selectedCell) return;
    window.requestAnimationFrame(() =>
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }, [selectedCell?.cell.id]);

  function chooseWorkset(id: string) {
    setSelectedCell(null);
    navigate(`/evals/worksets/${encodeURIComponent(id)}`);
  }

  function prefetchWorkset(workset: EvalWorkset) {
    void queryClient.prefetchQuery({
      queryKey: ["evals", "workset", workset.id],
      queryFn: ({ signal }) => evalApi.workset(workset.id, signal),
      staleTime: 1_000,
    });
    void queryClient.prefetchQuery({
      queryKey: resultKey(workset.id, null),
      queryFn: ({ signal }) => evalApi.worksetResults(workset.id, signal),
      staleTime: resultStaleMs,
      gcTime: resultCacheMs,
    });
  }

  function prefetchTask(task: EvalTaskOverview) {
    if (!selectedWorkset) return;
    void queryClient.prefetchQuery({
      queryKey: taskKey(selectedWorkset.id, task.id),
      queryFn: ({ signal }) => evalApi.task(selectedWorkset.id, task.id, signal),
      staleTime: taskStaleMs,
      gcTime: resultCacheMs,
    });
    void queryClient.prefetchQuery({
      queryKey: resultKey(selectedWorkset.id, task.id),
      queryFn: ({ signal }) => evalApi.taskResults(selectedWorkset.id, task.id, signal),
      staleTime: resultStaleMs,
      gcTime: resultCacheMs,
    });
  }

  const warmTaskIds = visibleTasks.slice(0, 8).map((task) => task.id).join(":");
  useEffect(() => {
    if (!selectedWorkset || taskRoute) return;
    for (const task of visibleTasks.slice(0, 8)) prefetchTask(task);
  }, [selectedWorkset?.id, taskRoute, warmTaskIds]);

  function chooseTask(id: string) {
    if (!selectedWorkset) return;
    setSelectedCell(null);
    navigate(
      `/evals/worksets/${encodeURIComponent(selectedWorkset.id)}/tasks/${encodeURIComponent(id)}`,
    );
  }

  if (!route) {
    return (
      <main className="live-evals">
        <section className="eval-page-head">
          <div>
            <p className="eyebrow"><Radio aria-hidden="true" /> Coordinator evidence</p>
            <h1>Evals</h1>
            <p>Durable benchmark progress and retained result artifacts.</p>
          </div>
          <div className={`live-health-callout ${currentHealth.status}`}>
            <span className="live-health-pulse" />
            <div><strong>{currentHealth.status}</strong><p>{currentHealth.message}</p></div>
            <small>live</small>
          </div>
        </section>
        <section className="eval-stat-strip" aria-label="Evaluation summary">
          <div><Activity aria-hidden="true" /><span>Worksets</span><strong>{overview.worksets.length}</strong></div>
          <div><CircleDashed aria-hidden="true" /><span>Coordinates</span><strong>{overview.summary.total}</strong></div>
          <div><Radio aria-hidden="true" /><span>Running</span><strong>{overview.summary.running}</strong></div>
          <div><CheckCircle2 aria-hidden="true" /><span>Finished</span><strong>{overview.summary.success + overview.summary.failed}</strong></div>
        </section>
        <section className="eval-full-table" aria-labelledby="worksets-heading">
          <header><p className="rail-label">Benchmarks</p><h2 id="worksets-heading">Worksets</h2></header>
          <div className="eval-table-heading eval-workset-grid" aria-hidden="true">
            <span>Benchmark</span><span>Progress</span><span>Tasks</span><span>Created</span><span />
          </div>
          {orderedWorksets.map((workset) => (
            <button
              type="button"
              className="eval-table-row eval-workset-grid"
              onClick={() => chooseWorkset(workset.id)}
              onPointerEnter={() => prefetchWorkset(workset)}
              onFocus={() => prefetchWorkset(workset)}
              key={workset.id}
            >
              <span className="eval-primary-cell"><strong>{workset.profile}</strong><small>{workset.digest.slice(0, 16)}</small></span>
              <ProgressBar summary={workset.summary} label={`${workset.profile} progress`} />
              <span>{workset.taskCount}</span>
              <span>{formatWorksetDate(workset.createdAtMs)}</span>
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
          {!orderedWorksets.length ? <p className="eval-empty-list">No durable worksets yet.</p> : null}
        </section>
      </main>
    );
  }

  if (!selectedWorkset) {
    return (
      <main className="live-evals eval-route-empty">
        <PageBack onClick={() => navigate("/evals")}>All evals</PageBack>
        <AlertTriangle aria-hidden="true" />
        <h1>Workset not found</h1>
        <p>The coordinator no longer reports this durable workset.</p>
      </main>
    );
  }

  if (!taskRoute) {
    return (
      <main className="live-evals">
        <section className="eval-page-head eval-detail-head">
          <div>
            <PageBack onClick={() => navigate("/evals")}>All evals</PageBack>
            <p className="eyebrow">Benchmark · {selectedWorkset.digest.slice(0, 16)}</p>
            <h1>{selectedWorkset.profile}</h1>
            <p>{selectedWorkset.taskCount} tasks across the retained harness, model, thinking, and repetition sweep.</p>
          </div>
          <ProgressBar summary={selectedWorkset.summary} label={`${selectedWorkset.profile} progress`} />
        </section>
        {resultsQuery.data ? <Analytics points={resultsQuery.data.points} /> : (
          <section className="eval-chart-loading">
            <CircleDashed aria-hidden="true" />
            <span>{resultsQuery.error?.message ?? "Loading completed result points…"}</span>
          </section>
        )}
        <section className="eval-full-table" aria-labelledby="tasks-heading">
          <header className="eval-table-toolbar">
            <div><p className="rail-label">Progress</p><h2 id="tasks-heading">Tasks</h2></div>
            <label className="live-eval-search"><Search aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tasks" aria-label="Filter evaluation tasks" /></label>
            <div className="live-filter" role="group" aria-label="Task filter">
              {(["all", "active", "issues", "complete"] as MatrixFilter[]).map((option) => (
                <button type="button" className={filter === option ? "is-active" : ""} onClick={() => setFilter(option)} key={option}>{option}</button>
              ))}
            </div>
          </header>
          <div className="eval-table-heading eval-task-grid" aria-hidden="true">
            <span>Task</span><span>Progress</span><span>Treatments</span><span />
          </div>
          {visibleTasks.map((task) => (
            <button type="button" className="eval-table-row eval-task-grid" onClick={() => chooseTask(task.id)} onPointerEnter={() => prefetchTask(task)} onFocus={() => prefetchTask(task)} key={task.id}>
              <span className="eval-primary-cell"><strong>{task.label}</strong><small>{task.name}</small></span>
              <ProgressBar summary={task.summary} label={`${task.label} progress`} />
              <span>{task.treatmentCount}</span>
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
          {worksetQuery.isPending ? <p className="eval-empty-list">Loading workset tasks…</p> : null}
          {worksetQuery.error ? <p className="eval-empty-list">{worksetQuery.error.message}</p> : null}
          {!worksetQuery.isPending && !visibleTasks.length ? <p className="eval-empty-list">No tasks match this filter.</p> : null}
        </section>
      </main>
    );
  }

  if (!selectedTaskOverview && !worksetQuery.isPending) {
    return (
      <main className="live-evals eval-route-empty">
        <PageBack onClick={() => chooseWorkset(selectedWorkset.id)}>Benchmark</PageBack>
        <AlertTriangle aria-hidden="true" />
        <h1>Task not found</h1>
        <p>This task is not part of the selected workset.</p>
      </main>
    );
  }

  return (
    <main className="live-evals">
      <section className="eval-page-head eval-detail-head">
        <div>
          <PageBack onClick={() => chooseWorkset(selectedWorkset.id)}>{selectedWorkset.profile}</PageBack>
          <p className="eyebrow">Task · {selectedTaskOverview?.digest.slice(0, 16) ?? "loading"}</p>
          <h1>{selectedTaskOverview?.label ?? "Loading task…"}</h1>
          <p>{selectedTaskOverview?.name}</p>
        </div>
        {selectedTaskOverview ? <ProgressBar summary={selectedTaskOverview.summary} label={`${selectedTaskOverview.label} progress`} /> : null}
      </section>
      {resultsQuery.data ? (
        <Analytics points={resultsQuery.data.points} view="runs" />
      ) : null}
      <section className="eval-run-section" aria-labelledby="treatments-heading">
        {taskQuery.isPending ? (
          <div className="eval-empty-panel"><CircleDashed aria-hidden="true" /><h2>Loading treatments</h2><p>Reading only this task's repetition matrix.</p></div>
        ) : taskQuery.error ? (
          <div className="eval-empty-panel"><AlertTriangle aria-hidden="true" /><h2>Task unavailable</h2><p>{taskQuery.error.message}</p></div>
        ) : selectedTask ? (
          <>
            <header className="eval-task-panel-header">
              <div><p className="rail-label">Runs</p><h2 id="treatments-heading">Treatments and repetitions</h2></div>
              <span>{selectedTask.treatments.length} treatments</span>
            </header>
            <div className="eval-matrix-legend" aria-label="Result legend">
              <span><i className="passed" /> verifier passed</span><span><i className="failed" /> verifier / execution failed</span><span><i className="running" /> running</span><span><i className="unclaimed" /> unclaimed</span>
            </div>
            <div className="eval-task-matrix-scroll">
              <table className="eval-task-matrix">
                <thead><tr><th>Treatment</th>{repetitions.map((repetition) => <th key={repetition}>#{repetition}</th>)}<th>Done</th></tr></thead>
                <tbody>
                  {selectedTask.treatments.map((treatment) => (
                    <tr key={treatment.id}>
                      <th scope="row"><span>{treatment.harness} · {treatment.model}</span><small>{treatment.thinking} thinking</small></th>
                      {repetitions.map((repetition) => {
                        const cell = treatment.cells.find((candidate) => candidate.repetition === repetition);
                        if (!cell) return <td className="is-unavailable" key={repetition} />;
                        return (
                          <td key={repetition}>
                            <button type="button" className={`eval-matrix-cell ${cell.state} ${cell.status ?? cell.outcome ?? ""}`} title={`${treatment.label}\nrepetition ${repetition} · ${coordinateLabel(cell)}\n${formatDuration(cell.durationMs)}`} aria-label={`${treatment.label}, repetition ${repetition}: ${coordinateLabel(cell)}`} aria-pressed={selectedCell?.cell.id === cell.id} disabled={!cell.detailId} onClick={() => setSelectedCell({ treatment, cell })}>
                              <CellMark cell={cell} />
                            </button>
                          </td>
                        );
                      })}
                      <td className="live-row-total">{treatment.cells.filter((cell) => cell.state === "success" || cell.state === "failed").length}/{treatment.cells.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selectedCell?.cell.detailId ? (
              <div className="live-case-slot" ref={detailRef}><CaseInspector detailId={selectedCell.cell.detailId} cell={selectedCell.cell} treatment={selectedCell.treatment} onClose={() => setSelectedCell(null)} /></div>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
