import {
  queryOptions,
  useQueryClient,
  useSuspenseQueries,
  type QueryClient,
} from "@tanstack/react-query";
import { Component, useDeferredValue, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router";
import { evalRouteFromPath, type EvalRoute } from "./evalRoute";
import { evalApi, type EvalSummary, type EvalWorksetDetail } from "./evalApi";
import { LiveEvals } from "./LiveEvals";

const activeOverviewPollMs = 2_000;
const quietOverviewPollMs = 30_000;
const detailPollMs = 15_000;
const resultStaleMs = 30_000;
const resultCacheMs = 30 * 60_000;

type EvalRouteErrorBoundaryProps = {
  children: ReactNode;
};

type EvalRouteErrorBoundaryState = {
  error: Error | null;
};

class EvalRouteErrorBoundary extends Component<
  EvalRouteErrorBoundaryProps,
  EvalRouteErrorBoundaryState
> {
  state: EvalRouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): EvalRouteErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Evaluation surface failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="live-evals-boot page-grid" role="alert">
        <p className="eyebrow">Nanocodex · durable evaluations</p>
        <h1>Evals unavailable</h1>
        <p>{this.state.error.message}</p>
      </main>
    );
  }
}

function summaryComplete(summary: EvalSummary) {
  return summary.running === 0 && summary.unclaimed === 0;
}

function cachedWorksetComplete(worksetId: string, queryClient: QueryClient) {
  const detail = queryClient.getQueryData<EvalWorksetDetail>([
    "evals",
    "workset",
    worksetId,
  ]);
  return detail ? summaryComplete(detail.workset.summary) : false;
}

function OverviewRoute() {
  const [overviewQuery, clusterQuery] = useSuspenseQueries({
    queries: [
      queryOptions({
        queryKey: ["evals", "overview"],
        queryFn: ({ signal }) => evalApi.overview(signal),
        refetchInterval: (query) => {
          const data = query.state.data;
          return data && summaryComplete(data.summary)
            ? quietOverviewPollMs
            : activeOverviewPollMs;
        },
        refetchIntervalInBackground: false,
        refetchOnMount: "always" as const,
        refetchOnWindowFocus: "always" as const,
        refetchOnReconnect: "always" as const,
        staleTime: 0,
      }),
      queryOptions({
        queryKey: ["evals", "cluster"],
        queryFn: ({ signal }) => evalApi.cluster(signal),
        refetchInterval: 10_000,
        refetchIntervalInBackground: false,
        staleTime: 5_000,
      }),
    ],
  });
  return (
    <LiveEvals
      data={{
        kind: "overview",
        overview: overviewQuery.data,
        cluster: clusterQuery.data,
      }}
    />
  );
}

function WorksetRoute({ route }: { route: Extract<EvalRoute, { kind: "workset" }> }) {
  const queryClient = useQueryClient();
  const [worksetQuery, analyticsQuery] = useSuspenseQueries({
    queries: [
      queryOptions({
        queryKey: ["evals", "workset", route.worksetId],
        queryFn: ({ signal }) => evalApi.workset(route.worksetId, signal),
        refetchInterval: (query) => {
          const data = query.state.data;
          return data && summaryComplete(data.workset.summary) ? false : 10_000;
        },
        refetchIntervalInBackground: false,
      }),
      queryOptions({
        queryKey: ["evals", "analytics", route.worksetId],
        queryFn: ({ signal }) => evalApi.worksetAnalytics(route.worksetId, signal),
        refetchInterval: () => cachedWorksetComplete(route.worksetId, queryClient)
          ? false
          : detailPollMs,
        staleTime: resultStaleMs,
        gcTime: resultCacheMs,
        refetchOnWindowFocus: false,
      }),
    ],
  });
  return (
    <LiveEvals
      data={{
        kind: "workset",
        detail: worksetQuery.data,
        analytics: analyticsQuery.data,
      }}
    />
  );
}

function TaskRoute({ route }: { route: Extract<EvalRoute, { kind: "task" }> }) {
  const queryClient = useQueryClient();
  const [worksetQuery, taskQuery, resultsQuery] = useSuspenseQueries({
    queries: [
      queryOptions({
        queryKey: ["evals", "workset", route.worksetId],
        queryFn: ({ signal }) => evalApi.workset(route.worksetId, signal),
        refetchInterval: (query) => {
          const data = query.state.data;
          return data && summaryComplete(data.workset.summary) ? false : 10_000;
        },
        refetchIntervalInBackground: false,
      }),
      queryOptions({
        queryKey: ["evals", "task", route.worksetId, route.taskId],
        queryFn: ({ signal }) => evalApi.task(route.worksetId, route.taskId, signal),
        refetchInterval: () => cachedWorksetComplete(route.worksetId, queryClient)
          ? false
          : detailPollMs,
        refetchIntervalInBackground: true,
        staleTime: resultStaleMs,
        gcTime: resultCacheMs,
        refetchOnWindowFocus: false,
      }),
      queryOptions({
        queryKey: ["evals", "task-results", route.worksetId, route.taskId],
        queryFn: ({ signal }) => evalApi.taskResults(route.worksetId, route.taskId, signal),
        refetchInterval: () => cachedWorksetComplete(route.worksetId, queryClient)
          ? false
          : detailPollMs,
        staleTime: resultStaleMs,
        gcTime: resultCacheMs,
        refetchOnWindowFocus: false,
      }),
    ],
  });
  return (
    <LiveEvals
      data={{
        kind: "task",
        detail: worksetQuery.data,
        task: taskQuery.data,
        results: resultsQuery.data,
        taskId: route.taskId,
      }}
    />
  );
}

function UnknownRoute() {
  return (
    <main className="live-evals-boot page-grid" role="alert">
      <p className="eyebrow">Nanocodex · durable evaluations</p>
      <h1>Eval view not found</h1>
      <p>Return to Evals and choose a retained workset.</p>
    </main>
  );
}

function EvalsContent({ route }: { route: EvalRoute }) {
  if (route.kind === "overview") return <OverviewRoute />;
  if (route.kind === "workset") return <WorksetRoute route={route} />;
  if (route.kind === "task") return <TaskRoute route={route} />;
  return <UnknownRoute />;
}

export function Evals() {
  const location = useLocation();
  const pathname = useDeferredValue(location.pathname);
  return (
    <EvalRouteErrorBoundary key={pathname}>
      <EvalsContent route={evalRouteFromPath(pathname)} />
    </EvalRouteErrorBoundary>
  );
}
