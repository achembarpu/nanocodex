import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createServer } from "vite";
import {
  pathForCommit,
  pathForSurface,
  productNavigation,
  surfaceFromUrl,
} from "../src/navigation.ts";

const application = readFileSync(new URL("../src/NanocodexApp.tsx", import.meta.url), "utf8");
const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const routeLoaders = readFileSync(new URL("../src/routeLoaders.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

type RepositoryIntentSettler = <T>(options: {
  navigationId: number;
  latestNavigationId(): number;
  preparation: Promise<T>;
  onPrepared(prepared: T): void;
  onFailure(): void;
  navigate(): void;
}) => Promise<"ready" | "failed" | "stale">;

async function loadRepositoryIntentSettler(): Promise<RepositoryIntentSettler> {
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
  });
  try {
    const module = await server.ssrLoadModule("/src/NanocodexApp.tsx");
    return module.settleRepositoryNavigationIntent as RepositoryIntentSettler;
  } finally {
    await server.close();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("maps every Nanocodex surface to a stable application route", () => {
  assert.deepEqual(
    ["home", "agent", "multiplayer", "world", "changelog", "docs", "code", "commits", "requests", "evals"].map((surface) => [
      surface,
      pathForSurface(surface as Parameters<typeof pathForSurface>[0]),
    ]),
    [
      ["home", "/"],
      ["agent", "/agent"],
      ["multiplayer", "/multiplayer"],
      ["world", "/world"],
      ["changelog", "/changelog"],
      ["docs", "/docs"],
      ["code", "/code"],
      ["commits", "/commits"],
      ["requests", "/requests"],
      ["evals", "/evals"],
    ],
  );
});

test("resolves direct routes and legacy view links", () => {
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/evals")), "evals");
  assert.equal(
    surfaceFromUrl(new URL("https://nanocodex.test/evals/worksets/terminal-bench/tasks/fix-git")),
    "evals",
  );
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/code/")), "code");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/changelog")), "changelog");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/agent?thread=demo")), "agent");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/multiplayer?room=demo")), "multiplayer");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/world?thread=demo")), "world");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/docs/core/owned-agent")), "docs");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/?view=commits")), "commits");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/unknown")), "home");
});

test("commit deep links stay inside the product", () => {
  const hash = "a".repeat(40);
  assert.equal(pathForCommit(hash), `/commits?commit=${hash}`);
  assert.match(application, /commitHashFromSearch\(location\.search\)/);
  assert.match(application, /scrollToCommit\(requestedCommit\)/);
});

test("deep product links retain prepared client navigation", () => {
  assert.match(application, /<Changelog onCommitClick=\{handleCommitClick\} \/>/);
  assert.match(application, /handleCommitClick[\s\S]*?navigateToPreparedRepository\("commits", destination/);
  assert.match(application, /handleEvalPathClick[\s\S]*?preloadSurface\("evals"\)[\s\S]*?startTransition\(\(\) => navigate\(destination\)\)/);
  assert.match(application, /href=\{terminalBenchWorksetPath\}[\s\S]*?onClick=\{\(event\) => handleEvalPathClick\(event, terminalBenchWorksetPath\)\}[\s\S]*?Terminal-Bench 2\.1 high:/);
});

test("the shared shell presents Source without changing the stable Code route", () => {
  assert.deepEqual(productNavigation.at(-1), {
    surface: "code",
    label: "Source",
    shortcut: "S",
  });
  assert.match(application, /aria-keyshortcuts=\{item\.shortcut\}/);
  assert.match(application, /<ProductNavigationLabel/);
  assert.match(application, /key === "s"[\s\S]*?\? "code"/);
  assert.doesNotMatch(application, /key === "t"[\s\S]*?\? "code"/);
  assert.doesNotMatch(application, /className=\{surface === "requests" \? "nav-optional/);
  assert.doesNotMatch(application, /className="header-source"/);
});

test("global product shortcuts are visible and browser Find remains native", () => {
  assert.deepEqual(
    productNavigation.map(({ label, shortcut }) => [label, shortcut]),
    [["Agent", "A"], ["Multiplayer", "P"], ["World", "W"], ["Changelog", "H"], ["Commits", "C"], ["Docs", "D"], ["Evals", "E"], ["Source", "S"]],
  );
  assert.match(application, /title=\{`\$\{item\.label\} \(\$\{item\.shortcut\}\)`\}/);
  assert.match(application, /key === "h"[\s\S]*?\? "changelog"/);
  assert.match(application, /key === "p"[\s\S]*?\? "multiplayer"/);
  assert.match(application, /key === "w"[\s\S]*?\? "world"/);
  assert.match(application, /surface === "world" && \["w", "a", "s", "d"\]\.includes\(key\)/);
  assert.doesNotMatch(application, /aria-keyshortcuts="H"[\s\S]*Nanocodex home/);
  assert.doesNotMatch(
    application,
    /surface === "code"[\s\S]{0,180}key === "f"/,
  );
});

test("the active navigation item is bold without a selection underline", () => {
  assert.match(css, /\.surface-switch a\.is-active \.surface-label\s*\{[^}]*font-weight:\s*600/);
  assert.doesNotMatch(css, /\.surface-switch a\.is-active \.surface-label::after/);
});

test("every primary route begins preloading on touch or pointer intent", () => {
  assert.match(application, /productNavigation\.map/);
  assert.match(application, /onPointerDown=\{\(\) => preloadSurface\(item\.surface\)\}/);
  assert.match(application, /onPointerDown=\{\(\) => preloadSurface\("home"\)\}/);
});

test("Source and Commits navigation prepares exact route state before navigating", () => {
  const preparation = routeLoaders.slice(
    routeLoaders.indexOf("export function prepareRepositorySurface"),
    routeLoaders.indexOf("export async function preloadDirectSurface"),
  );
  assert.match(
    preparation,
    /const snapshotRequest = loadRepositorySnapshot\(\)[\s\S]*?const pierreRequest = preparePierreWorker\(\)[\s\S]*?Promise\.all\(\[repositoryRequest, snapshotRequest\]\)[\s\S]*?preloadPreferredPublishedFile[\s\S]*?Promise\.all\(\[pierreRequest, sourceFileRequest\]\)[\s\S]*?preloadPierreFile[\s\S]*?loadCodeBrowser\(\)/,
  );
  assert.match(
    routeLoaders,
    /const preparePierreWorker[\s\S]*?preloadPierreWorker\(\)/,
  );
  assert.match(
    preparation,
    /loadPublishedCommitHistory\(requestedCommit\)[\s\S]*?const patchRequest = Promise\.all\(\[repositoryRequest, historyRequest\]\)[\s\S]*?preloadPublishedRepositoryPatchBody[\s\S]*?const syntaxRequest = Promise\.all\(\[pierreRequest, historyRequest\]\)[\s\S]*?preloadPierrePaths[\s\S]*?loadCommitCodeStream\(\)[\s\S]*?loadVirtualCommitList\(\)/,
  );
  assert.match(
    preparation,
    /repositorySurfaceRequests\.get\(key\)[\s\S]*?if \(adopt\) existing\.adopt\(\)[\s\S]*?repositorySurfaceRequests\.set\(key, prepared\)/,
  );
  assert.match(
    preparation,
    /prepareCommitSurface\(requestedCommit, adopted\)[\s\S]*?preloadPublishedRepositoryPatchBody\([\s\S]*?adopted/,
  );
  assert.match(
    preparation,
    /if \(repositorySnapshotRequest\) return repositorySnapshotRequest;[\s\S]*?loadPublishedRepositorySnapshot\(\)[\s\S]*?repositorySnapshotRequest = undefined/,
  );
  assert.doesNotMatch(preparation, /window\.location\.search/);
  assert.match(preparation, /preloadPublishedRepositoryPatchBody/);

  const prefetch = application.slice(
    application.indexOf("const preloadSurface"),
    application.indexOf("const navigateToPreparedRepository"),
  );
  assert.match(
    prefetch,
    /nextSurface === "code" \|\| nextSurface === "commits"[\s\S]*?void prepareRepositorySurface\(nextSurface\)\.catch/,
  );
  assert.doesNotMatch(prefetch, /setSnapshot|navigate\(/);

  const navigation = application.slice(
    application.indexOf("const navigateToPreparedRepository"),
    application.indexOf("const handleSurfaceClick"),
  );
  assert.match(
    navigation,
    /const navigateToPreparedRepository[\s\S]*?settleRepositoryNavigationIntent\(\{[\s\S]*?preparation: prepareRepositorySurface\(\s*nextSurface,\s*requestedCommit,\s*true/,
  );
  assert.match(
    navigation,
    /nextSurface === "code" \|\| nextSurface === "commits"[\s\S]*?navigateToPreparedRepository\(nextSurface, destination, navigationId, nextThreadId\)/,
  );
  assert.match(
    navigation,
    /latestNavigationId: \(\) => surfaceNavigationId\.current/,
  );
  assert.match(
    navigation,
    /onPrepared:[\s\S]*?flushSync\([\s\S]*?commitPreparedRepository\(preparedRepository\)[\s\S]*?navigate: \(\) => startTransition/,
  );
  assert.match(
    navigation,
    /onFailure:[\s\S]*?flushSync\([\s\S]*?setRepositoryLoadError\(nextSurface\)[\s\S]*?navigate: \(\) => startTransition/,
  );
  assert.match(
    application,
    /if \(!needsRepository \|\| repositoryLoadError === surface\) return;/,
  );
  assert.match(
    application,
    /prepareRepositorySurface\(nextSurface, requestedCommit, true\)[\s\S]*?repositoryRequestId\.current !== requestId[\s\S]*?startTransition\(\(\) => \{[\s\S]*?commitPreparedRepository\(loaded\)[\s\S]*?setRepositoryLoadError\(\(current\) => current === nextSurface \? null : current\)/,
  );
  assert.match(
    navigation,
    /commitHashFromDestination\(destination\)/,
  );
  assert.match(
    application,
    /surface === "code" \? repositoryLoadError === "code" \?[\s\S]*?surface === "commits" \? repositoryLoadError === "commits" \?/,
  );
});

test("deferred repository navigation is owned by the latest intent", async () => {
  const settle = await loadRepositoryIntentSettler();
  const source = deferred<string>();
  const commits = deferred<string>();
  const transitions: string[] = [];
  let latestNavigationId = 1;

  const staleSource = settle({
    navigationId: 1,
    latestNavigationId: () => latestNavigationId,
    preparation: source.promise,
    onPrepared: (snapshot) => transitions.push(`commit:${snapshot}`),
    onFailure: () => transitions.push("failure:source"),
    navigate: () => transitions.push("navigate:source"),
  });
  await Promise.resolve();
  assert.deepEqual(transitions, []);

  latestNavigationId = 2;
  const currentCommits = settle({
    navigationId: 2,
    latestNavigationId: () => latestNavigationId,
    preparation: commits.promise,
    onPrepared: (snapshot) => transitions.push(`commit:${snapshot}`),
    onFailure: () => transitions.push("failure:commits"),
    navigate: () => transitions.push("navigate:commits"),
  });
  commits.resolve("history");
  assert.equal(await currentCommits, "ready");
  assert.deepEqual(transitions, ["commit:history", "navigate:commits"]);

  source.resolve("snapshot");
  assert.equal(await staleSource, "stale");
  assert.deepEqual(transitions, ["commit:history", "navigate:commits"]);

  const failed = deferred<string>();
  latestNavigationId = 3;
  const currentFailure = settle({
    navigationId: 3,
    latestNavigationId: () => latestNavigationId,
    preparation: failed.promise,
    onPrepared: (snapshot) => transitions.push(`commit:${snapshot}`),
    onFailure: () => transitions.push("failure:repository"),
    navigate: () => transitions.push("navigate:error"),
  });
  failed.reject(new Error("repository unavailable"));
  assert.equal(await currentFailure, "failed");
  assert.deepEqual(transitions, [
    "commit:history",
    "navigate:commits",
    "failure:repository",
    "navigate:error",
  ]);
});

test("a direct visit waits for its complete route preload before mounting the shell", () => {
  assert.match(
    entry,
    /const application = import\("\.\/NanocodexApp"\);[\s\S]*?Promise\.all\(\[\s*application,\s*preloadDirectSurface\(directUrl\),\s*\]\)\.then\([\s\S]*?module\.mountNanocodexApp\(preparedRoute\)/,
  );

  const preload = routeLoaders.slice(routeLoaders.indexOf("export async function preloadDirectSurface"));
  assert.doesNotMatch(preload, /loadPublished(?:RepositorySnapshot|CommitHistory)\([^)]*\)\.catch/);
  assert.match(preload, /sourceFile: prepared\.sourceFile/);
  assert.match(preload, /const surface = surfaceFromUrl\(url\)/);
  assert.doesNotMatch(entry, /lazy\(/);
  assert.match(
    application,
    /<Suspense fallback=\{null\}>\s*<NanocodexApp preparedRoute=\{preparedRoute\} \/>/,
  );
  assert.match(application, /preparedRoute\.DocsComponent \?\? null/);
  assert.match(application, /preparedRoute\.repositorySnapshot/);
  assert.match(application, /preparedRoute\.sourceFile/);
  assert.match(application, /preparedRoute\.commitHistory/);
});

test("direct preloading selects only the work owned by the resolved route", () => {
  const preload = routeLoaders.slice(routeLoaders.indexOf("export async function preloadDirectSurface"));
  assert.match(
    preload,
    /surface === "home" \|\| surface === "agent"[\s\S]*?const experience = loadAgentExperience\(\)[\s\S]*?deploymentHealth\.read\(\)[\s\S]*?Promise\.all\(\[loadHomeFrame\(\), experience\]\)/,
  );
  assert.match(preload, /surface === "multiplayer"[\s\S]*?loadMultiplayer\(\)/);
  assert.match(preload, /surface === "world"[\s\S]*?loadMonsterWorld\(\)/);
  assert.match(preload, /surface === "changelog"[\s\S]*?preloadChangelog\(\)/);
  assert.match(preload, /surface === "docs"[\s\S]*?preloadDocsRoute\(url\.pathname\)/);
  assert.match(
    preload,
    /surface === "code"[\s\S]*?prepareCodeSurface\(url\.search\)/,
  );
  assert.match(
    preload,
    /surface === "commits"[\s\S]*?prepareCommitSurface\(commitHashFromUrl\(url\)\)/,
  );
  assert.match(
    preload,
    /surface === "evals"\) await preloadEvalOverview\(\);\s*return \{\};/,
  );
});

test("Fast Refresh reuses the existing React root", () => {
  assert.match(application, /container\.__nanocodexRoot \?\?= createRoot\(container\)/);
});

test("the router leaves transition policy to each prepared surface", () => {
  assert.match(application, /<BrowserRouter useTransitions=\{false\}>/);
});
