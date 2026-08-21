import type {
  HarnessCommit,
  RepositoryFile,
} from "./threadRepositorySnapshot";

type PublishedRepositoryFile = RepositoryFile & {
  contentUrl: string | null;
};

type PublishedRepositoryDocument = {
  repository: {
    fullName: string;
    branch: string;
    head: string;
    totalCommits: number;
    indexedCommits?: number;
    commitPageSize?: number;
    dirty: boolean;
    dirtyCount: number;
  };
  generatedAt: string;
  tree: PublishedRepositoryFile[];
};

export type PublishedRepositorySnapshot = PublishedRepositoryDocument & {
  historyLoaded: boolean;
  commits: HarnessCommit[];
  readFile(file: RepositoryFile): Promise<string>;
  commitPatchUrl: string | ((commit: HarnessCommit) => string);
};

type Fetch = typeof fetch;

type PrefetchedPatch = {
  controller: AbortController;
  response: Promise<Response>;
};

let snapshotPreload: Promise<PublishedRepositorySnapshot> | undefined;
let historyPreload: Promise<PublishedRepositorySnapshot> | undefined;
const prefetchedPatches = new Map<string, PrefetchedPatch>();

export async function loadPublishedRepositorySnapshot(
  includeHistory = true,
  request: Fetch = fetch,
  development = import.meta.env?.DEV ?? false,
): Promise<PublishedRepositorySnapshot> {
  if (request === fetch && !development) {
    return preloadPublishedRepositorySnapshot(includeHistory);
  }
  return loadPublishedRepositorySnapshotUncached(
    includeHistory,
    request,
    development,
  );
}

export function preloadPublishedRepositorySnapshot(
  includeHistory = true,
): Promise<PublishedRepositorySnapshot> {
  if (includeHistory && historyPreload) return historyPreload;
  if (!includeHistory && historyPreload) return historyPreload;
  if (!includeHistory && snapshotPreload) return snapshotPreload;

  const loading = loadPublishedRepositorySnapshotUncached(
    includeHistory,
    fetch,
    false,
  ).then((snapshot) => {
    if (snapshot.historyLoaded) snapshotPreload = Promise.resolve(snapshot);
    return snapshot;
  }).catch((error) => {
    if (includeHistory) historyPreload = undefined;
    else snapshotPreload = undefined;
    throw error;
  });
  if (includeHistory) historyPreload = loading;
  else snapshotPreload = loading;
  return loading;
}

export function preloadPreferredPublishedFile(
  snapshot: PublishedRepositorySnapshot,
  search = typeof window === "undefined" ? "" : window.location.search,
): Promise<string> | undefined {
  const requestedPath = new URLSearchParams(search).get("path");
  const preferredFile = snapshot.tree.find((file) =>
    file.path === requestedPath && file.contentUrl != null
  ) ?? snapshot.tree.find((file) =>
    file.path === "src/main.rs" && file.contentUrl != null
  ) ?? snapshot.tree.find((file) =>
    file.path === "README.md" && file.contentUrl != null
  ) ?? snapshot.tree.find((file) => file.contentUrl != null);
  return preferredFile == null ? undefined : snapshot.readFile(preferredFile);
}

export function preloadPublishedRepositoryPatch(
  patchUrl: PublishedRepositorySnapshot["commitPatchUrl"],
): Promise<Response> | undefined {
  if (typeof patchUrl !== "string") return undefined;
  const existing = prefetchedPatches.get(patchUrl);
  if (existing != null) return existing.response;
  const controller = new AbortController();
  markCommitPerformance("patch-prefetch-start");
  const response = fetch(patchUrl, {
    cache: "default",
    signal: controller.signal,
  }).then((result) => {
    markCommitPerformance("patch-prefetch-headers");
    return result;
  }).catch((error) => {
    prefetchedPatches.delete(patchUrl);
    throw error;
  });
  prefetchedPatches.set(patchUrl, { controller, response });
  return response;
}

export function fetchPublishedRepositoryPatch(
  patchUrl: string,
  signal: AbortSignal,
): Promise<Response> {
  const prefetched = prefetchedPatches.get(patchUrl);
  if (prefetched == null) {
    return fetch(patchUrl, { cache: "default", signal });
  }

  prefetchedPatches.delete(patchUrl);
  if (signal.aborted) prefetched.controller.abort(signal.reason);
  else {
    signal.addEventListener(
      "abort",
      () => prefetched.controller.abort(signal.reason),
      { once: true },
    );
  }
  return prefetched.response;
}

async function loadPublishedRepositorySnapshotUncached(
  includeHistory: boolean,
  request: Fetch,
  development: boolean,
): Promise<PublishedRepositorySnapshot> {
  const base = development
    ? "/__nanocodex/repository"
    : "/api/repository";
  const aliasCache: RequestCache = development ? "no-store" : "default";
  markCommitPerformance("repository-request-start", { includeHistory });
  const snapshotRequest = request(`${base}/snapshot`, {
    cache: aliasCache,
  }).then((response) => {
    markCommitPerformance("repository-snapshot-headers");
    return response;
  });
  const commitsRequest = includeHistory
    ? request(`${base}/commits`, { cache: aliasCache }).then((response) => {
        markCommitPerformance("repository-commits-headers");
        return response;
      })
    : Promise.resolve<Response | undefined>(undefined);
  const [snapshotResponse, commitsResponse] = await Promise.all([
    snapshotRequest,
    commitsRequest,
  ]);
  if (!snapshotResponse.ok) {
    throw new Error(`Repository request failed (${snapshotResponse.status})`);
  }
  const snapshot = await snapshotResponse.json() as PublishedRepositoryDocument;
  requireRepositoryDocument(snapshot);
  requireGeneration(snapshotResponse, snapshot.repository.head);
  markCommitPerformance("repository-snapshot-parsed");
  if (includeHistory && request === fetch && !development) {
    void preloadPublishedRepositoryPatch(
      `${base}/commits/${snapshot.repository.head}.diff`,
    )?.catch(() => undefined);
  }

  let commits: HarnessCommit[] = [];
  if (includeHistory) {
    if (commitsResponse == null) {
      throw new Error("Repository commit request is missing");
    }
    if (!commitsResponse.ok) {
      throw new Error(`Commit request failed (${commitsResponse.status})`);
    }
    requireGeneration(commitsResponse, snapshot.repository.head);
    const body: unknown = await commitsResponse.json();
    if (!Array.isArray(body)) throw new Error("Repository commits are invalid");
    commits = body as HarnessCommit[];
    markCommitPerformance("repository-commits-parsed", {
      commitCount: commits.length,
    });
  }

  const fileContents = new Map<string, Promise<string>>();

  return {
    ...snapshot,
    historyLoaded: includeHistory,
    commits,
    async readFile(file) {
      const cached = fileContents.get(file.objectId);
      if (cached) return cached;
      const published = snapshot.tree.find((candidate) =>
        candidate.objectId === file.objectId && candidate.path === file.path
      );
      if (published?.contentUrl == null) {
        throw new Error(`${file.path} is not available as published text`);
      }
      const pending = request(published.contentUrl, {
        cache: development ? "no-store" : "default",
      }).then((response) => {
        if (!response.ok) {
          throw new Error(`File request failed (${response.status})`);
        }
        return response.text();
      }).catch((error) => {
        if (fileContents.get(file.objectId) === pending) {
          fileContents.delete(file.objectId);
        }
        throw error;
      });
      fileContents.set(file.objectId, pending);
      return pending;
    },
    commitPatchUrl: development
      ? (commit) => `${base}/commits.diff?hash=${commit.hash}`
      : `${base}/commits/${snapshot.repository.head}.diff`,
  };
}

function markCommitPerformance(
  name: string,
  detail?: Record<string, boolean | number>,
): void {
  if (typeof performance === "undefined") return;
  performance.mark(`nanocodex:commits:${name}`, { detail });
}

function requireRepositoryDocument(
  value: PublishedRepositoryDocument,
): void {
  if (
    value == null ||
    typeof value !== "object" ||
    value.repository == null ||
    typeof value.repository.head !== "string" ||
    typeof value.repository.branch !== "string" ||
    !Array.isArray(value.tree)
  ) {
    throw new Error("Repository snapshot is invalid");
  }
}

function requireGeneration(response: Response, expected: string): void {
  const generation = response.headers.get("x-repository-generation");
  if (generation != null && generation !== expected) {
    throw new Error("Repository publication changed while loading");
  }
}
