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
    ["home", "agent", "changelog", "docs", "code", "commits", "requests", "evals"].map((surface) => [
      surface,
      pathForSurface(surface as Parameters<typeof pathForSurface>[0]),
    ]),
    [
      ["home", "/"],
      ["agent", "/agent"],
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
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/docs/core/owned-agent")), "docs");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/?view=commits")), "commits");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/unknown")), "home");
});

test("commit deep links stay inside the product", () => {
  const hash = "a".repeat(40);
  assert.equal(pathForCommit(hash), `/commits?commit=${hash}`);
  assert.match(application, /commitHashFromSearch\(location\.search\)/);
  assert.match(application, /scrollToCommit\(index\)/);
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
    [["Agent", "A"], ["Changelog", "H"], ["Commits", "C"], ["Docs", "D"], ["Evals", "E"], ["Source", "S"]],
  );
  assert.match(application, /title=\{`\$\{item\.label\} \(\$\{item\.shortcut\}\)`\}/);
  assert.match(application, /key === "h"[\s\S]*?\? "changelog"/);
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
  const preparation = application.slice(
    application.indexOf("function prepareRepositorySurface"),
    application.indexOf("const scopes"),
  );
  assert.match(
    preparation,
    /nextSurface === "code"[\s\S]*?preparePierreWorker\(\)[\s\S]*?loadCodeBrowser\(\)[\s\S]*?loadRepositorySnapshot\(false\)/,
  );
  assert.match(
    preparation,
    /loadCommitCodeStream\(\)[\s\S]*?loadVirtualCommitList\(\)[\s\S]*?loadRepositorySnapshot\(true\)/,
  );

  const prefetch = application.slice(
    application.indexOf("const preloadSurface"),
    application.indexOf("const navigateToSurface"),
  );
  assert.match(
    prefetch,
    /nextSurface === "code" \|\| nextSurface === "commits"[\s\S]*?void prepareRepositorySurface\(nextSurface\)\.catch/,
  );
  assert.doesNotMatch(prefetch, /setSnapshot|navigate\(/);

  const navigation = application.slice(
    application.indexOf("const navigateToSurface"),
    application.indexOf("const handleSurfaceClick"),
  );
  assert.match(
    navigation,
    /nextSurface === "code" \|\| nextSurface === "commits"[\s\S]*?settleRepositoryNavigationIntent\(\{[\s\S]*?preparation: prepareRepositorySurface\(nextSurface\)/,
  );
  assert.match(
    navigation,
    /latestNavigationId: \(\) => surfaceNavigationId\.current/,
  );
  assert.match(
    navigation,
    /onPrepared:[\s\S]*?flushSync\([\s\S]*?commitRepositorySnapshot\(preparedSnapshot\)[\s\S]*?navigate: \(\) => startTransition/,
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
    /repositoryRequestId\.current !== requestId[\s\S]*?startTransition\(\(\) => \{[\s\S]*?commitRepositorySnapshot\(loaded\)[\s\S]*?setRepositoryLoadError\(\(current\) => current === nextSurface \? null : current\)/,
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
    /const application = loadNanocodexApp\(\);[\s\S]*?Promise\.all\(\[\s*application,\s*preloadDirectSurface\(directUrl\),\s*\]\)\.then\([\s\S]*?renderApp\(module\.NanocodexApp, preparedRoute\)/,
  );
  assert.doesNotMatch(
    entry.slice(entry.indexOf("if (directPath"), entry.indexOf("function preloadDirectSurface")),
    /renderApp\(\)/,
  );

  const preload = entry.slice(
    entry.indexOf("function preloadDirectSurface"),
    entry.indexOf("function renderApp"),
  );
  assert.doesNotMatch(preload, /\bvoid\b|\.catch\(/);
  assert.match(preload, /const surface = surfaceFromUrl\(url\)/);
  assert.doesNotMatch(entry, /lazy\(loadNanocodexApp\)/);
  assert.match(
    entry,
    /<Suspense fallback=\{null\}>\s*<NanocodexApp preparedRoute=\{preparedRoute\} \/>/,
  );
  assert.doesNotMatch(application, /<Suspense/);
  assert.match(application, /preparedRoute\.DocsComponent \?\? null/);
  assert.match(application, /preparedRoute\.repositorySnapshot/);
});

test("direct preloading selects only the work owned by the resolved route", () => {
  const preload = entry.slice(
    entry.indexOf("function preloadDirectSurface"),
    entry.indexOf("function renderApp"),
  );
  assert.match(
    preload,
    /surface === "home" \|\| surface === "agent"[\s\S]*?import\("\.\/HomeFrame"\)[\s\S]*?import\("\.\/AgentExperience"\)/,
  );
  assert.match(preload, /surface === "changelog"[\s\S]*?preloadChangelog\(\)/);
  assert.match(preload, /surface === "docs"[\s\S]*?preloadDocsRoute\(url\.pathname\)/);
  assert.match(
    preload,
    /surface === "code"[\s\S]*?preloadPublishedRepositorySnapshot\(false\)[\s\S]*?preloadPreferredPublishedFile/,
  );
  assert.match(
    preload,
    /surface === "commits"[\s\S]*?preloadPublishedRepositorySnapshot\(true\)[\s\S]*?preloadPublishedRepositoryPatch/,
  );
  assert.match(
    preload,
    /surface === "requests"\) return Promise\.resolve\(\{\}\);\s*surface satisfies "evals";\s*return import\("\.\/Evals"\)\.then\(\(\) => \(\{\}\)\)/,
  );
});

test("Fast Refresh reuses the existing React root", () => {
  assert.match(entry, /container\.__nanocodexRoot \?\?= createRoot\(container\)/);
});

test("the router leaves transition policy to each prepared surface", () => {
  assert.match(entry, /<BrowserRouter useTransitions=\{false\}>/);
});
