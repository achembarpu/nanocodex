import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  pathForCommit,
  pathForSurface,
  productNavigation,
  surfaceFromUrl,
} from "../src/navigation.ts";

const application = readFileSync(new URL("../src/NanocodexApp.tsx", import.meta.url), "utf8");
const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

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
