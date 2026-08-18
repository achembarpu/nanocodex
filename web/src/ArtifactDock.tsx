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
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type {
  ArtifactStore,
  ArtifactDocument,
  ArtifactInput,
} from "nanocodex-artifacts";
import { LiveReactArtifact } from "./LiveReactArtifact";
import {
  getBrowserThread,
  openKernelWorkspace,
  subscribeThreadWorkspaceChanges,
} from "./workspace";

export const ArtifactDock = memo(function ArtifactDock({
  agentReady,
  onPrompt,
}: {
  agentReady: boolean;
  onPrompt(artifact: ArtifactDocument, prompt: string): void;
}) {
  const initialArtifact = useRef(exampleDocument()).current;
  const [store, setStore] = useState<ArtifactStore>();
  const [artifacts, setArtifacts] = useState<readonly ArtifactDocument[]>([initialArtifact]);
  const [selectedId, setSelectedId] = useState(initialArtifact.id);
  const [fullscreen, setFullscreen] = useState(() => !window.matchMedia("(max-width: 740px)").matches);
  const [message, setMessage] = useState("");
  const refreshEpoch = useRef(0);
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];

  const refresh = useCallback(async (nextStore: ArtifactStore | undefined) => {
    if (!nextStore) return;
    const epoch = ++refreshEpoch.current;
    try {
      const { artifacts: next, rejected } = await nextStore.scan();
      if (epoch !== refreshEpoch.current) return;
      setArtifacts(next);
      setSelectedId((current) => current && next.some(({ id }) => id === current) ? current : next[0]?.id);
      setMessage(rejected.length
        ? `Skipped ${rejected.length} invalid artifact document${rejected.length === 1 ? "" : "s"}.`
        : next.length ? "" : "Ask the agent to create any custom interface, or preview the live React demo.");
    } catch (error) {
      if (epoch === refreshEpoch.current) setMessage(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      openKernelWorkspace(),
      import("nanocodex-artifacts"),
    ]).then(async ([nextWorkspace, { ArtifactStore }]) => {
      if (!active) return;
      const nextStore = new ArtifactStore(nextWorkspace);
      setStore(nextStore);
      const existing = await nextStore.scan();
      if (!active) return;
      if (existing.artifacts.length) {
        await refresh(nextStore);
        return;
      }
      refreshEpoch.current++;
      setArtifacts([initialArtifact]);
      setSelectedId(initialArtifact.id);
      setMessage("Ask the agent to create any custom interface, or preview the live React demo.");
    }).catch((error) => active && setMessage(errorMessage(error)));
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    return subscribeThreadWorkspaceChanges(
      getBrowserThread().id,
      () => void refresh(store),
    );
  }, [refresh, store]);

  useEffect(() => {
    if (!store) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(store);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh, store]);

  const remove = async () => {
    if (!store || !selected || !window.confirm(`Delete the artifact “${selected.title}”?`)) return;
    try {
      await store.remove(selected.id);
      await refresh(store);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const download = () => {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([selected.source], { type: "text/javascript" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selected.id}.ui.js`;
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
    if (!store) return;
    try {
      const artifact = await store.save(exampleArtifact());
      refreshEpoch.current++;
      setArtifacts((current) => [artifact, ...current.filter(({ id }) => id !== artifact.id)]);
      setSelectedId(artifact.id);
      setFullscreen(!window.matchMedia("(max-width: 740px)").matches);
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

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
          <DockAction label="Refresh artifacts" onClick={() => void refresh(store)}><RefreshCw /></DockAction>
          <DockAction label="Download artifact" disabled={!selected} onClick={download}><Download /></DockAction>
          <DockAction label="Delete artifact" disabled={!selected} onClick={() => void remove()}><Trash2 /></DockAction>
          <DockAction label={fullscreen ? "Exit fullscreen" : "View fullscreen"} onClick={() => setFullscreen((value) => !value)}>
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </DockAction>
          <DockAction label="Dock interface" onClick={() => setFullscreen(false)}><PanelRightClose /></DockAction>
        </div>
      </header>
      <div className="artifact-canvas">
        {selected ? (
          <LiveReactArtifact artifact={selected} onAction={ask} />
        ) : (
          <div className="artifact-empty">
            <PanelRightOpen aria-hidden="true" />
            {message ? <p>{message}</p> : null}
            <button className="artifact-preview-button" type="button" onClick={() => void createExample()}>
              Preview custom UI
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

function exampleArtifact(): ArtifactInput & { id: string } {
  return {
    id: "artifact-demo",
    title: "Live React artifact demo",
    source: `
function App({ sendPrompt }) {
  const [theme, setTheme] = React.useState("electric");
  return html\`<main className=\${theme}>
    <style>\${\`
      body { overflow: hidden; }
      main { min-height: 100vh; padding: clamp(32px, 8vw, 110px); color: #eaffff; background: radial-gradient(circle at 15% 10%, #154f68, #071116 55%); transition: .5s; }
      main.steampunk { color: #ffe6ae; background: radial-gradient(circle at 15% 10%, #70451e, #17100a 58%); }
      h1 { max-width: 850px; margin: 0; font: 800 clamp(50px, 9vw, 130px)/.86 system-ui; letter-spacing: -.07em; }
      p { max-width: 650px; font-size: clamp(18px, 2.2vw, 28px); opacity: .78; }
      button { margin: 12px 12px 0 0; padding: 13px 18px; color: inherit; background: #ffffff12; border: 1px solid currentColor; border-radius: 999px; cursor: pointer; }
    \`}</style>
    <h1>Speak the interface into existence.</h1>
    <p>This is real React generated at runtime, isolated from the credential-bearing host page.</p>
    <button onClick=\${() => setTheme(theme === "electric" ? "steampunk" : "electric")}>Retheme locally</button>
    <button onClick=\${() => sendPrompt("Turn this live interface into an animated mission control dashboard")}>Ask the agent to evolve it</button>
  </main>\`;
}`,
  };
}

function exampleDocument(): ArtifactDocument {
  return {
    version: 1,
    ...exampleArtifact(),
    createdAt: 0,
    updatedAt: 0,
  };
}
