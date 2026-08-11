import { LiveEvals, useEvalOverview } from "./LiveEvals";

export function Evals() {
  const overview = useEvalOverview();
  if (overview.data) return <LiveEvals overview={overview.data} />;
  return (
    <main className="live-evals-boot page-grid">
      <p className="eyebrow">Nanocodex · durable evaluations</p>
      <h1>{overview.isPending ? "Connecting to evals…" : "Evals unavailable"}</h1>
      <p>
        {overview.isPending
          ? "Loading coordinator worksets and retained results."
          : overview.error?.message ?? "The evaluation API is unavailable. Retrying automatically…"}
      </p>
    </main>
  );
}
