import type { ComponentType } from "react";
import { deploymentHealth } from "./deploymentHealth";
import { surfaceFromUrl, type Surface } from "./navigation";
import type {
  PublishedCommitHistory,
  PublishedRepositorySnapshot,
} from "./publishedRepository";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{40}$/;

export type PreparedDirectRoute = {
  commitHistory?: PublishedCommitHistory;
  DocsComponent?: ComponentType;
  repositorySnapshot?: PublishedRepositorySnapshot;
};

export type PreparedRepositorySurface =
  | { surface: "code"; snapshot: PublishedRepositorySnapshot }
  | { surface: "commits"; history: PublishedCommitHistory };

type PreparedCodeSurface = Extract<
  PreparedRepositorySurface,
  { surface: "code" }
>;
type PreparedCommitSurface = Extract<
  PreparedRepositorySurface,
  { surface: "commits" }
>;

let repositorySnapshotRequest: Promise<PublishedRepositorySnapshot> | undefined;

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
  }));
export const loadPierreWorkerProvider = () =>
  import("./PierreWorkerProvider").then((module) => ({
    default: module.PierreWorkerProvider,
    preloadPierreWorker: module.preloadPierreWorker,
  }));
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
): Promise<PreparedRepositorySurface> {
  return surface === "code"
    ? prepareCodeSurface()
    : prepareCommitSurface(requestedCommit);
}

async function prepareCodeSurface(search?: string): Promise<PreparedCodeSurface> {
  const [repository, snapshot] = await Promise.all([
    loadPublishedRepository(),
    loadRepositorySnapshot(),
    loadPierreWorkerProvider().then((module) => module.preloadPierreWorker()),
    loadCodeBrowser(),
  ]);
  await repository.preloadPreferredPublishedFile(snapshot, search);
  return { surface: "code", snapshot };
}

async function prepareCommitSurface(
  requestedCommit?: string,
): Promise<PreparedCommitSurface> {
  const [repository] = await Promise.all([
    loadPublishedRepository(),
    loadPierreWorkerProvider().then((module) => module.preloadPierreWorker()),
    loadCommitCodeStream(),
    loadVirtualCommitList(),
  ]);
  return {
    surface: "commits",
    history: await repository.loadPublishedCommitHistory(requestedCommit),
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
    // Start the sole credential lookup while the React shell and route modules
    // are still in flight. Rendering never waits for this network request.
    void deploymentHealth.read().catch(() => undefined);
    await Promise.all([loadHomeFrame(), loadAgentExperience()]);
    return {};
  }
  if (surface === "code") {
    const prepared = await prepareCodeSurface(url.search);
    return { repositorySnapshot: prepared.snapshot };
  }
  if (surface === "commits") {
    const prepared = await prepareCommitSurface(commitHashFromUrl(url));
    void loadPublishedRepository()
      .then((module) =>
        module.preloadPublishedRepositoryPatch(prepared.history.initialPage.patchUrl)
      )
      .catch(() => undefined);
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
