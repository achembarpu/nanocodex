import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLocation } from "react-router";
import { LiveEvals, useEvalOverview } from "./LiveEvals";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 30 * 60 * 1_000,
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});

export function Evals() {
  return (
    <QueryClientProvider client={queryClient}>
      <EvalsContent />
    </QueryClientProvider>
  );
}

function EvalsContent() {
  const overview = useEvalOverview();
  const location = useLocation();
  const detailRoute = location.pathname.startsWith("/evals/worksets/");
  if (overview.data || detailRoute) return <LiveEvals overview={overview.data} />;
  if (overview.isPending) return null;
  return (
    <main className="live-evals-boot page-grid">
      <p className="eyebrow">Nanocodex · durable evaluations</p>
      <h1>Evals unavailable</h1>
      <p>{overview.error?.message ?? "The evaluation API is unavailable. Retrying automatically…"}</p>
    </main>
  );
}
