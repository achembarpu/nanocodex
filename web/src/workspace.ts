import type { Workspace } from "nanocodex/browser/workspace";

const THREAD_STORAGE_KEY = "nanocodex-thread-id";
const THREAD_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type BrowserThread = {
  id: string;
  workspaceName: string;
  repositoryName: string;
  branch: "nanocodex";
  remoteUrl: string;
  shareUrl: string;
};

let browserThread: BrowserThread | undefined;
const workspaces = new Map<string, Promise<Workspace>>();

export function getBrowserThread(): BrowserThread {
  if (browserThread) return browserThread;
  const url = new URL(window.location.href);
  const requested = url.searchParams.get("thread")?.toLowerCase();
  let retained: string | undefined;
  try {
    retained = window.localStorage.getItem(THREAD_STORAGE_KEY)?.toLowerCase();
  } catch {
    retained = undefined;
  }
  const id = requested && THREAD_PATTERN.test(requested)
    ? requested
    : retained && THREAD_PATTERN.test(retained)
      ? retained
      : crypto.randomUUID();
  try {
    window.localStorage.setItem(THREAD_STORAGE_KEY, id);
  } catch {
    // The query parameter remains the durable/shareable thread identity.
  }
  if (url.searchParams.get("thread") !== id) {
    url.searchParams.set("thread", id);
    window.history.replaceState(window.history.state, "", url);
  }
  browserThread = {
    id,
    workspaceName: `nanocodex-thread-${id}`,
    repositoryName: `thread-${id}`,
    branch: "nanocodex",
    remoteUrl: `${window.location.origin}/git/thread-${id}`,
    shareUrl: url.toString(),
  };
  return browserThread;
}

export function openKernelWorkspace(): Promise<Workspace> {
  return openThreadWorkspace(getBrowserThread().id);
}

export function openThreadWorkspace(threadId: string): Promise<Workspace> {
  const name = `nanocodex-thread-${threadId}`;
  let workspace = workspaces.get(name);
  workspace ??= import("nanocodex/browser/workspace")
    .then((module) => module.open({ name }))
    .catch((error) => {
      workspaces.delete(name);
      throw error;
    });
  workspaces.set(name, workspace);
  return workspace;
}

export function subscribeThreadWorkspaceChanges(
  threadId: string,
  listener: () => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(`nanocodex-git-${threadId}`);
  channel.addEventListener("message", listener);
  return () => channel.close();
}
