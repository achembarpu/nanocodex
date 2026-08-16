import {
  Download,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { Workspace } from "nanocodex/browser/workspace";

import {
  createArtifactTool,
  deleteArtifact,
  loadArtifacts,
  type ArtifactDocument,
} from "./artifact";
import { openKernelWorkspace } from "./workspace";

const ArtifactRenderer = lazy(() => import("./ArtifactRenderer").then((module) => ({
  default: module.ArtifactRenderer,
})));

export const ArtifactDock = memo(function ArtifactDock({
  latest,
  agentReady,
  onPrompt,
}: {
  latest: ArtifactDocument | undefined;
  agentReady: boolean;
  onPrompt(artifact: ArtifactDocument, prompt: string): void;
}) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [artifacts, setArtifacts] = useState<ArtifactDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [message, setMessage] = useState("Loading artifacts…");
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];

  const refresh = useCallback(async (nextWorkspace: Workspace | undefined) => {
    if (!nextWorkspace) return;
    try {
      const next = await loadArtifacts(nextWorkspace);
      setArtifacts(next);
      setSelectedId((current) => current && next.some(({ id }) => id === current) ? current : next[0]?.id);
      setMessage(next.length ? "" : "Ask the agent to create a dashboard, report, chart, or interactive explainer.");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void openKernelWorkspace().then(async (nextWorkspace) => {
      if (!active) return;
      setWorkspace(nextWorkspace);
      await refresh(nextWorkspace);
    }).catch((error) => active && setMessage(errorMessage(error)));
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    if (!workspace) return;
    const timer = window.setInterval(() => void refresh(workspace), 2_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(workspace);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, workspace]);

  useEffect(() => {
    if (!latest) return;
    setArtifacts((current) => [latest, ...current.filter(({ id }) => id !== latest.id)]);
    setSelectedId(latest.id);
    setOpen(true);
    setMessage("");
  }, [latest]);

  const remove = async () => {
    if (!workspace || !selected || !window.confirm(`Delete the artifact “${selected.title}”?`)) return;
    try {
      await deleteArtifact(workspace, selected.id);
      await refresh(workspace);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const download = () => {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selected.id}.artifact.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const ask = (prompt: string) => {
    if (!selected) return;
    if (!agentReady) {
      setMessage("Connect the agent before running an artifact action.");
      return;
    }
    if (!window.confirm(`Send this artifact action to the agent?\n\n${prompt}`)) return;
    onPrompt(selected, prompt);
    setMessage("Artifact action queued for the agent.");
  };

  const createExample = async () => {
    if (!workspace) return;
    try {
      const tool = createArtifactTool(workspace, (artifact) => {
        setArtifacts((current) => [artifact, ...current.filter(({ id }) => id !== artifact.id)]);
        setSelectedId(artifact.id);
        setMessage("");
      });
      await tool.handler(exampleArtifact());
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  if (!open) {
    return (
      <aside className="artifact-dock is-collapsed" aria-label="Artifacts">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open artifacts" title="Open artifacts">
          <Sparkles aria-hidden="true" />
          {artifacts.length ? <span>{artifacts.length}</span> : null}
        </button>
      </aside>
    );
  }

  return (
    <aside className={`artifact-dock${fullscreen ? " is-fullscreen" : ""}`} aria-label="Artifacts">
      <header className="artifact-dock-header">
        <Sparkles aria-hidden="true" />
        {artifacts.length > 1 ? (
          <select value={selected?.id} onChange={(event) => setSelectedId(event.target.value)} aria-label="Selected artifact">
            {artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title}</option>)}
          </select>
        ) : <strong>{selected?.title ?? "Artifacts"}</strong>}
        <div>
          <DockAction label="Refresh artifacts" onClick={() => void refresh(workspace)}><RefreshCw /></DockAction>
          <DockAction label="Download artifact" disabled={!selected} onClick={download}><Download /></DockAction>
          <DockAction label="Delete artifact" disabled={!selected} onClick={() => void remove()}><Trash2 /></DockAction>
          <DockAction label={fullscreen ? "Exit fullscreen" : "View fullscreen"} onClick={() => setFullscreen((value) => !value)}>
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </DockAction>
          <DockAction label="Close artifacts" onClick={() => { setFullscreen(false); setOpen(false); }}><PanelRightClose /></DockAction>
        </div>
      </header>
      <div className="artifact-canvas">
        {selected ? (
          <Suspense fallback={<div className="artifact-empty">Loading visual renderer…</div>}>
            <ArtifactRenderer artifact={selected} onPrompt={ask} />
          </Suspense>
        ) : (
          <div className="artifact-empty">
            <PanelRightOpen aria-hidden="true" />
            <p>{message}</p>
            <button className="artifact-button is-primary" type="button" onClick={() => void createExample()}>
              Preview an example
            </button>
          </div>
        )}
      </div>
      {message && selected ? <p className="artifact-dock-status" role="status">{message}</p> : null}
    </aside>
  );
});

function DockAction({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-label={label} title={label}>{children}</button>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exampleArtifact() {
  return {
    id: "artifact-demo",
    title: "Interactive artifact demo",
    spec: {
      root: "root",
      elements: {
        root: { type: "Stack", props: { gap: 14 }, children: ["intro", "metrics", "chart", "table", "action"] },
        intro: { type: "Card", props: { title: "Client-side artifacts", subtitle: "Generated as trusted JSON UI and persisted in OPFS.", tone: "accent" }, children: ["intro-text"] },
        "intro-text": { type: "Text", props: { text: "The model describes the interface. Nanocodex validates the specification, and your component catalog renders it without executing model-generated JavaScript.", tone: "muted" } },
        metrics: { type: "Grid", props: { columns: 3, gap: 10 }, children: ["metric-a", "metric-b", "metric-c"] },
        "metric-a": { type: "Metric", props: { label: "Rendering", value: "Client", detail: "No artifact server", trend: "up" } },
        "metric-b": { type: "Metric", props: { label: "Persistence", value: "OPFS", detail: "Survives refreshes", trend: "up" } },
        "metric-c": { type: "Metric", props: { label: "Components", value: "16", detail: "Catalog constrained", trend: "neutral" } },
        chart: { type: "BarChart", props: { title: "Example workflow activity", data: [
          { label: "Files", value: 18 }, { label: "Tools", value: 27 }, { label: "Artifacts", value: 42 }, { label: "Actions", value: 31 },
        ] } },
        table: { type: "Table", props: {
          columns: [{ key: "surface", label: "Surface" }, { key: "owner", label: "Owner" }, { key: "state", label: "State" }],
          rows: [
            { surface: "Workspace", owner: "Application", state: "Persistent" },
            { surface: "Artifact", owner: "Application", state: "Interactive" },
            { surface: "Agent", owner: "Nanocodex", state: "In flow" },
          ],
        } },
        action: { type: "Button", props: { label: "Ask how this works", prompt: "Explain how this artifact is rendered and persisted entirely on the client.", variant: "primary" } },
      },
    },
  };
}
