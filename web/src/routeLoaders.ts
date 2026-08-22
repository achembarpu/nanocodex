import type { ComponentType } from "react";
import { deploymentHealth } from "./deploymentHealth";
import { surfaceFromUrl, type Surface } from "./navigation";
import type {
  PublishedCommitHistory,
  PreparedPublishedFile,
  PublishedRepositorySnapshot,
} from "./publishedRepository";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{40}$/;
const PREPARED_SURFACE_RETENTION_MS = 25_000;

export type PreparedDirectRoute = {
  commitHistory?: PublishedCommitHistory;
  DocsComponent?: ComponentType;
  sourceFile?: PreparedPublishedFile;
  repositorySnapshot?: PublishedRepositorySnapshot;
};

export type PreparedRepositorySurface =
  | {
      surface: "code";
      snapshot: PublishedRepositorySnapshot;
      sourceFile?: PreparedPublishedFile;
    }
  | { surface: "commits"; history: PublishedCommitHistory };

type PreparedCodeSurface = Extract<
  PreparedRepositorySurface,
  { surface: "code" }
>;
type PreparedCommitSurface = Extract<
  PreparedRepositorySurface,
  { surface: "commits" }
>;

type PreparedRepositoryRequest = {
  adopted: boolean;
  adopt(): void;
  expiry?: ReturnType<typeof setTimeout>;
  loading: Promise<PreparedRepositorySurface>;
  settled: boolean;
};

let repositorySnapshotRequest: Promise<PublishedRepositorySnapshot> | undefined;
const repositorySurfaceRequests = new Map<string, PreparedRepositoryRequest>();

const loadEvalsModule = () => import("./Evals");
const loadPublishedRepository = () => import("./publishedRepository");

export const loadEvals = () =>
  loadEvalsModule().then((module) => ({ default: module.Evals }));
export const loadChangelog = () => import("./Changelog");
export const loadDocs = () => import("./Docs");
export const loadHomeFrame = () =>
  import("./HomeFrame").then((module) => ({ default: module.HomeFrame }));
export const loadAgentExperience = () =>
  import("./AgentExperience").then((module) => ({
    default: module.AgentExperience,
    preloadAgentTerminal: module.preloadAgentTerminal,
  }));
export const loadMultiplayer = () =>
  import("./Multiplayer").then((module) => ({ default: module.Multiplayer }));
export const loadMonsterWorld = () =>
  import("./MonsterWorld").then((module) => ({ default: module.MonsterWorld }));
export const loadPierreWorkerProvider = () =>
  import("./PierreWorkerProvider").then((module) => ({
    default: module.PierreWorkerProvider,
    preloadPierreFile: module.preloadPierreFile,
    preloadPierrePaths: module.preloadPierrePaths,
    preloadPierreWorker: module.preloadPierreWorker,
  }));

const preparePierreWorker = () =>
  loadPierreWorkerProvider().then((pierre) => {
    pierre.preloadPierreWorker();
    return pierre;
  });
export const loadCodeBrowser = () =>
  import("./CodeBrowser").then((module) => ({ default: module.CodeBrowser }));
export const loadCommitCodeStream = () =>
  import("./CommitCodeStream").then((module) => ({
    default: module.CommitCodeStream,
  }));
export const loadVirtualCommitList = () =>
  import("./VirtualCommitList").then((module) => ({
    default: module.VirtualCommitList,
  }));

export async function preloadEvalOverview(): Promise<void> {
  const module = await loadEvalsModule();
  await module.preloadEvalOverview();
}

export function prepareRepositorySurface(
  surface: Extract<Surface, "code" | "commits">,
  requestedCommit?: string,
  adopt = false,
): Promise<PreparedRepositorySurface> {
  const key = preparedRepositoryKey(surface, requestedCommit);
  const existing = repositorySurfaceRequests.get(key);
  if (existing) {
    if (adopt) existing.adopt();
    return existing.loading;
  }

  let resolveAdopted!: () => void;
  const adopted = new Promise<void>((resolve) => {
    resolveAdopted = resolve;
  });
  const loading = surface === "code"
    ? prepareCodeSurface()
    : prepareCommitSurface(requestedCommit, adopted);
  const prepared: PreparedRepositoryRequest = {
    adopted: false,
    adopt: () => {
      if (prepared.adopted) return;
      prepared.adopted = true;
      clearTimeout(prepared.expiry);
      resolveAdopted();
      if (
        prepared.settled
        && repositorySurfaceRequests.get(key) === prepared
      ) {
        repositorySurfaceRequests.delete(key);
      }
    },
    loading,
    settled: false,
  };
  repositorySurfaceRequests.set(key, prepared);
  if (adopt) prepared.adopt();
  void loading.then(
    () => {
      prepared.settled = true;
      if (prepared.adopted) {
        if (repositorySurfaceRequests.get(key) === prepared) {
          repositorySurfaceRequests.delete(key);
        }
        return;
      }
      prepared.expiry = setTimeout(() => {
        if (repositorySurfaceRequests.get(key) === prepared) {
          repositorySurfaceRequests.delete(key);
        }
      }, PREPARED_SURFACE_RETENTION_MS);
    },
    () => {
      if (repositorySurfaceRequests.get(key) === prepared) {
        repositorySurfaceRequests.delete(key);
      }
    },
  );
  return loading;
}

function preparedRepositoryKey(
  surface: Extract<Surface, "code" | "commits">,
  requestedCommit?: string,
): string {
  return surface === "code" ? surface : `${surface}:${requestedCommit ?? "head"}`;
}

async function prepareCodeSurface(search?: string): Promise<PreparedCodeSurface> {
  const repositoryRequest = loadPublishedRepository();
  const snapshotRequest = loadRepositorySnapshot();
  const pierreRequest = preparePierreWorker();
  const sourceFileRequest = Promise.all([repositoryRequest, snapshotRequest])
    .then(([repository, snapshot]) =>
      repository.preloadPreferredPublishedFile(snapshot, search)
    );
  const preparedSourceFileRequest = Promise.all([pierreRequest, sourceFileRequest])
    .then(async ([pierre, sourceFile]) => {
      if (sourceFile) {
        await pierre.preloadPierreFile(sourceFile.file, sourceFile.contents);
      }
      return sourceFile;
    });
  const [snapshot, sourceFile] = await Promise.all([
    snapshotRequest,
    preparedSourceFileRequest,
    loadCodeBrowser(),
  ]);
  return { sourceFile, surface: "code", snapshot };
}

async function prepareCommitSurface(
  requestedCommit?: string,
  adopted: Promise<void> = Promise.resolve(),
): Promise<PreparedCommitSurface> {
  const repositoryRequest = loadPublishedRepository();
  const historyRequest = repositoryRequest.then((repository) =>
    repository.loadPublishedCommitHistory(requestedCommit)
  );
  const pierreRequest = preparePierreWorker();
  const patchRequest = Promise.all([repositoryRequest, historyRequest])
    .then(([repository, history]) =>
      repository.preloadPublishedRepositoryPatchBody(
        history.initialPage.patchUrl,
        adopted,
      )
    );
  const syntaxRequest = Promise.all([pierreRequest, historyRequest])
    .then(([pierre, history]) => {
      const initialPaths = history.initialPage.commits[0]?.files
        .map(({ path }) => path) ?? [];
      return pierre.preloadPierrePaths(initialPaths);
    });
  const [history] = await Promise.all([
    historyRequest,
    patchRequest,
    syntaxRequest,
    loadCommitCodeStream(),
    loadVirtualCommitList(),
  ]);
  return {
    surface: "commits",
    history,
  };
}

function loadRepositorySnapshot(): Promise<PublishedRepositorySnapshot> {
  if (repositorySnapshotRequest) return repositorySnapshotRequest;
  const loading = loadPublishedRepository()
    .then((module) => module.loadPublishedRepositorySnapshot())
    .catch((error) => {
      if (repositorySnapshotRequest === loading) {
        repositorySnapshotRequest = undefined;
      }
      throw error;
    });
  repositorySnapshotRequest = loading;
  return loading;
}

export async function preloadDirectSurface(url: URL): Promise<PreparedDirectRoute> {
  const surface = surfaceFromUrl(url);
  if (surface === "home" || surface === "agent") {
    const experience = loadAgentExperience();
    // The sole credential lookup starts beside the React shell. A configured
    // browser also fetches the authenticated terminal in that same window,
    // while signed-out startup never touches the Agent graph.
    void deploymentHealth.read().then(async (health) => {
      if (health.credentialSource !== null) {
        await (await experience).preloadAgentTerminal();
      }
    }).catch(() => undefined);
    await Promise.all([loadHomeFrame(), experience]);
    return {};
  }
  if (surface === "multiplayer") {
    await loadMultiplayer();
    return {};
  }
  if (surface === "world") {
    await loadMonsterWorld();
    return {};
  }
  if (surface === "code") {
    const prepared = await prepareCodeSurface(url.search);
    return {
      repositorySnapshot: prepared.snapshot,
      sourceFile: prepared.sourceFile,
    };
  }
  if (surface === "commits") {
    const prepared = await prepareCommitSurface(commitHashFromUrl(url));
    return { commitHistory: prepared.history };
  }
  if (surface === "changelog") {
    const module = await loadChangelog();
    await module.preloadChangelog();
    return {};
  }
  if (surface === "docs") {
    const module = await loadDocs();
    await module.preloadDocsRoute(url.pathname);
    return { DocsComponent: module.Docs };
  }
  if (surface === "evals") await preloadEvalOverview();
  return {};
}

function commitHashFromUrl(url: URL): string | undefined {
  const hash = url.searchParams.get("commit")?.toLowerCase();
  return hash && COMMIT_HASH_PATTERN.test(hash) ? hash : undefined;
}
