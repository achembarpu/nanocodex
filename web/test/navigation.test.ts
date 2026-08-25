import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  commitPreparationMatchesIntent,
  settleRepositoryNavigationIntent,
} from "../src/commitRouteState.ts";
import {
  connectDemoUrl,
  demoNavigation,
  gitNavigation,
  pathForCommit,
  pathForSurface,
  primaryNavigation,
  surfaceFromUrl,
} from "../src/navigation.ts";

const application = readFileSync(new URL("../src/NanocodexApp.tsx", import.meta.url), "utf8");
const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const monsterWorld = readFileSync(new URL("../src/MonsterWorld.tsx", import.meta.url), "utf8");
const routeLoaders = readFileSync(new URL("../src/routeLoaders.ts", import.meta.url), "utf8");
const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

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
  assert.match(application, /if \(nextSurface === "evals"\) \{\s*void preloadEvalOverview\(\)/);
  assert.match(application, /const navigateToSurface[\s\S]*?retainAgentExperience\(nextSurface\);\s*preloadSurface\(nextSurface\)[\s\S]*?startTransition\(\(\) => navigate\(destination\)\)/);
});

test("the shared shell presents Source without changing the stable Code route", () => {
  assert.deepEqual(gitNavigation.at(-1), {
    surface: "code",
    label: "Source",
    description: "Repository",
  });
  assert.doesNotMatch(application, /aria-keyshortcuts=\{item\./);
  assert.doesNotMatch(application, /data-mobile-label/);
  assert.doesNotMatch(application, /ProductNavigationLabel/);
  assert.doesNotMatch(application, /className=\{surface === "requests" \? "nav-optional/);
  assert.doesNotMatch(application, /className="header-source"/);
});

test("navigation does not capture global letter keys and browser Find remains native", () => {
  assert.deepEqual(
    [...demoNavigation, ...primaryNavigation, ...gitNavigation].map(({ label, description }) => [label, description]),
    [["Durable Agent", "Managed durable agent"], ["Multiplayer", "Shared room"], ["World", "Agent world"], ["Docs", "Reference"], ["Evals", "Benchmarks"], ["Changelog", "Releases"], ["Commits", "History"], ["Source", "Repository"]],
  );
  assert.doesNotMatch(application, /item\.shortcut|shortcut<\/small>|const nextSurface =\s*key/);
  assert.match(
    application,
    /surface === "world"[\s\S]{0,180}target === document\.activeElement[\s\S]{0,180}target\?\.matches\("\.monster-world-stage canvas"\)/,
  );
  assert.doesNotMatch(
    application,
    /surface === "code"[\s\S]{0,180}key === "f"/,
  );
});

test("the product navigation exposes the deliberate Demos and Git hierarchy", () => {
  assert.deepEqual(demoNavigation.map(({ label }) => label), ["Durable Agent", "Multiplayer", "World"]);
  assert.deepEqual(primaryNavigation.map(({ label }) => label), ["Docs", "Evals"]);
  assert.deepEqual(gitNavigation.map(({ label }) => label), ["Changelog", "Commits", "Source"]);
  assert.equal(connectDemoUrl, "https://nanocodex-connect-playground.gakonst.workers.dev");
  assert.match(application, /aria-label="Demos navigation"/);
  assert.match(application, /aria-label="Git navigation"/);
  assert.match(application, /href=\{connectDemoUrl\}[\s\S]*?target="_blank"[\s\S]*?rel="noreferrer"[\s\S]*?Connect demo \(opens in a new tab\)/);
  assert.match(application, /id="mobile-demos-title">Demos/);
  assert.match(application, /id="mobile-git-title">Git/);
});

test("Home removes browser thread identity and the managed Agent demo does not consume it", () => {
  assert.match(application, /surface === "home" \|\| surface === "docs" \? undefined : getBrowserThread\(\)\.id/);
  assert.equal(application.match(/getBrowserThread\(\)\.id/g)?.length, 1);
  assert.match(application, /const nextThreadId = threadId \?\? crypto\.randomUUID\(\)/);
  assert.match(application, /if \(surface !== "home" \|\| location\.pathname !== "\/"\) return;[\s\S]*?search\.delete\("thread"\)[\s\S]*?replace: true/);
  assert.match(application, /nextSurface === "home"[\s\S]*?pathForSurface\("home"\)/);
  assert.match(application, /if \(nextSurface === "home"\) \{[\s\S]*?navigate\(destination\)/);
  assert.doesNotMatch(application, /<AgentExperience[\s\S]*?threadId=\{threadId\}/);
  assert.doesNotMatch(application, /threadId=\{threadId \?\? getBrowserThread\(\)\.id\}/);
  assert.match(application, /const agentExperienceSurface = surface === "home" \|\| surface === "agent"[\s\S]*?: retainedAgentSurface/);
  assert.match(application, /landing=\{agentExperienceSurface === "home"\}/);
});

test("the active navigation item is bold without a selection underline", () => {
  assert.match(css, /\.surface-switch a\.is-active \.surface-label,[\s\S]*?\.surface-navigation-group\.is-active button \.surface-label\s*\{[^}]*font-weight:\s*600/);
  assert.doesNotMatch(css, /\.surface-switch a\.is-active \.surface-label::after/);
  assert.doesNotMatch(css, /\.surface-key/);
});

test("every primary route begins preloading on touch or pointer intent", () => {
  assert.match(application, /demoNavigation\.map/);
  assert.match(application, /primaryNavigation\.map/);
  assert.match(application, /gitNavigation\.map/);
  assert.match(application, /onFocus=\{\(\) => preloadSurface\(item\.surface\)\}/);
  assert.match(application, /onPointerEnter=\{\(\) => preloadSurface\(item\.surface\)\}/);
  assert.match(application, /onPointerDown=\{\(\) => preloadSurface\(item\.surface\)\}/);
  assert.match(application, /onFocus=\{\(\) => preloadSurface\("home"\)\}/);
  assert.match(application, /onPointerEnter=\{\(\) => preloadSurface\("home"\)\}/);
  assert.match(application, /onPointerDown=\{\(\) => preloadSurface\("home"\)\}/);
});

test("Vite owns one static application graph", () => {
  assert.doesNotMatch(viteConfig, /routePreloads|codeSplitting|manualChunks/);
  assert.doesNotMatch(`${entry}\n${application}\n${routeLoaders}`, /import\(/);
  for (const component of [
    "AgentExperience",
    "Changelog",
    "CodeBrowser",
    "CommitCodeStream",
    "Docs",
    "Evals",
    "MonsterWorld",
    "Multiplayer",
    "PierreWorkerProvider",
    "VirtualCommitList",
  ]) assert.match(application, new RegExp(`import \\{[^}]*\\b${component}\\b`));
});

test("the mounted shell prefetches route data without module-loader orchestration", () => {
  assert.doesNotMatch(
    application,
    /preloadProductSurfaces|PRODUCT_WARMUP_IDLE_TIMEOUT_MS|requestIdleCallback|scheduleIdleWarmup/,
  );
  assert.doesNotMatch(
    routeLoaders,
    /ProductSurfaceWarmup|productSurfaceWarmup|preloadProductSurfaces|Promise\.allSettled/,
  );

  const navigation = application.slice(
    application.indexOf("const navigateToSurface"),
    application.indexOf("const handleSurfaceClick"),
  );
  assert.match(
    navigation,
    /if \(nextSurface === "docs"\)[\s\S]*?preloadDocsRoute\(destination\)\.then\([\s\S]*?navigate\(destination\)/,
  );
  assert.match(
    navigation,
    /const ready = nextSurface === "code"[\s\S]*?commitPreparationMatchesIntent\([\s\S]*?commitHistoryTargetRef\.current,[\s\S]*?undefined[\s\S]*?if \(ready\)[\s\S]*?navigate\(destination\)/,
  );
  assert.match(css, /\.surface-switch > a,[\s\S]*?\.surface-navigation-group button\s*\{[^}]*touch-action:\s*manipulation/);
  assert.match(css, /\.surface-navigation-group button\s*\{[^}]*min-width:\s*44px/);
  assert.match(
    css,
    /@media \(max-width: 740px\)[\s\S]*?\.header-center \{[\s\S]*?display: none;[\s\S]*?\.mobile-navigation-trigger \{[\s\S]*?display: grid;[\s\S]*?\.mobile-navigation-grid \{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(application, /useModalBoundary\(\{[\s\S]*?open: mobileNavigationOpen/);
});

test("Source and Commits navigation prepares exact route state before navigating", () => {
  const preparation = routeLoaders.slice(
    routeLoaders.indexOf("export function prepareRepositorySurface"),
    routeLoaders.indexOf("export async function preloadDirectSurface"),
  );
  assert.match(
    preparation,
    /const snapshotRequest = loadRepositorySnapshot\(\)[\s\S]*?preloadPierreWorker\(\)[\s\S]*?snapshotRequest\.then[\s\S]*?preloadPreferredPublishedFile[\s\S]*?preloadPierreFile[\s\S]*?Promise\.all\(\[[\s\S]*?snapshotRequest,[\s\S]*?preparedSourceFileRequest/,
  );
  assert.match(
    routeLoaders,
    /import \{[\s\S]*?preloadPierreWorker,[\s\S]*?\} from "\.\/pierreWorkerResource"/,
  );
  assert.match(
    preparation,
    /loadPublishedCommitHistory\([\s\S]*?requestedCommit[\s\S]*?adopted[\s\S]*?preloadPierreWorker\(\)[\s\S]*?void historyRequest\.then[\s\S]*?preloadPublishedRepositoryPatch[\s\S]*?preloadPierrePaths[\s\S]*?const history = await historyRequest/,
  );
  assert.doesNotMatch(
    preparation,
    /import\(|loadCodeBrowser|loadCommitCodeStream|loadVirtualCommitList|preparePierreWorker/,
  );
  assert.match(
    preparation,
    /repositorySurfaceRequests\.get\(key\)[\s\S]*?if \(adopt\) existing\.adopt\(\)[\s\S]*?repositorySurfaceRequests\.set\(key, prepared\)/,
  );
  assert.match(
    preparation,
    /if \(repositorySnapshotRequest\) return repositorySnapshotRequest;[\s\S]*?loadPublishedRepositorySnapshot\(\)[\s\S]*?repositorySnapshotRequest = undefined/,
  );
  assert.doesNotMatch(preparation, /window\.location\.search/);
  assert.doesNotMatch(preparation, /preloadPublishedRepositoryPatchBody|arrayBuffer\(\)/);

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
    /if \(!needsRepository\) return;[\s\S]*?commitPreparationMatchesIntent\([\s\S]*?commitHistoryTargetRef\.current,[\s\S]*?requestedCommit[\s\S]*?failureIsCurrent/,
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
  const settle = settleRepositoryNavigationIntent;
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

test("exact commit preparation stays authoritative and plain history targets HEAD", () => {
  const exact = "a".repeat(40);
  assert.equal(commitPreparationMatchesIntent(exact, exact), true);
  assert.equal(commitPreparationMatchesIntent(undefined, undefined), true);
  assert.equal(commitPreparationMatchesIntent(undefined, exact), false);
  assert.equal(commitPreparationMatchesIntent(exact, undefined), false);
  assert.doesNotMatch(application, /export function commitPreparationMatchesIntent/);
  assert.doesNotMatch(application, /export async function settleRepositoryNavigationIntent/);

  assert.match(
    routeLoaders,
    /surface: "commits";[\s\S]*?requestedCommit\?: string/,
  );
  assert.match(
    routeLoaders,
    /return \{\s*surface: "commits",\s*history,\s*requestedCommit,\s*\}/,
  );
  assert.match(
    application,
    /commitHistoryTargetRef = useRef[\s\S]*?commitIntentTargetRef = useRef/,
  );
  assert.match(
    application,
    /useLayoutEffect\(\(\) => \{\s*surfaceNavigationId\.current\+\+;\s*commitIntentTargetRef\.current = surface === "commits" \? requestedCommit : undefined;/,
  );
  assert.match(
    application,
    /commitHistory[\s\S]*?commitPreparationMatchesIntent\(\s*commitHistoryTargetRef\.current,\s*requestedCommit/,
  );
  assert.match(
    application,
    /commitIntentTargetRef\.current = commit\.hash;\s*commitHistoryTargetRef\.current = commit\.hash;\s*setSelectedHash\(commit\.hash\)/,
  );
});

test("a direct visit adopts its prepared route before mounting the shell", () => {
  assert.match(
    entry,
    /function BrowserApplication[\s\S]*?useEffect\(\(\) => \{[\s\S]*?preloadDirectSurface\(url\)\.then\([\s\S]*?setPreparedRoute\(prepared\)/,
  );

  const preload = routeLoaders.slice(routeLoaders.indexOf("export async function preloadDirectSurface"));
  assert.doesNotMatch(preload, /loadPublished(?:RepositorySnapshot|CommitHistory)\([^)]*\)\.catch/);
  assert.match(preload, /sourceFile: prepared\.sourceFile/);
  assert.match(preload, /const surface = surfaceFromUrl\(url\)/);
  assert.doesNotMatch(entry, /import\(|lazy\(/);
  assert.match(
    entry,
    /<Suspense fallback=\{null\}>\s*<AccountSessionProvider>\s*<NanocodexApp preparedRoute=\{preparedRoute\} \/>\s*<\/AccountSessionProvider>/,
  );
  assert.match(application, /preparedRoute\.repositorySnapshot/);
  assert.match(application, /preparedRoute\.sourceFile/);
  assert.match(application, /preparedRoute\.commitHistory/);
});

test("direct preloading selects only the work owned by the resolved route", () => {
  const preload = routeLoaders.slice(routeLoaders.indexOf("export async function preloadDirectSurface"));
  assert.match(
    preload,
    /surface === "home" \|\| surface === "agent"\) \{\s*return \{\};/,
  );
  assert.match(preload, /surface === "multiplayer"\) \{\s*return \{\};/);
  assert.match(preload, /surface === "world"\) \{\s*return \{\};/);
  assert.doesNotMatch(routeLoaders, /loadWorldAssets/);
  assert.match(monsterWorld, /void loadWorldAssets\(\)\.then\(/);
  assert.match(monsterWorld, /drawMonsterWorld\(context, activeWorld, assetsRef\.current/);
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
    /surface === "evals" && url\.pathname\.replace[\s\S]*?=== "\/evals"\)[\s\S]*?await preloadEvalOverview\(\);[\s\S]*?return \{\};/,
  );
});

test("the application has one standard React root", () => {
  assert.equal([...entry.matchAll(/createRoot\(/g)].length, 1);
  assert.doesNotMatch(application, /mountNanocodexApp|createRoot|BrowserRouter|Suspense/);
});

test("the router leaves transition policy to each prepared surface", () => {
  assert.match(entry, /<BrowserRouter useTransitions=\{false\}>/);
});
