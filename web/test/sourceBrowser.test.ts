import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browser = source("../src/CodeBrowser.tsx");
const provider = source("../src/PierreWorkerProvider.tsx");
const pierre = source("../src/pierreCodeView.ts");
const styles = source("../src/SourceBrowser.css");

test("Source paths and lines round-trip through validated browser history", () => {
  assert.match(browser, /useLocation\(\)/);
  assert.match(browser, /useNavigate\(\)/);
  assert.match(browser, /new URLSearchParams\(search\)\.get\("path"\)/);
  assert.match(browser, /filePaths\.has\(requestedPath\)/);
  assert.match(browser, /search\.set\("path", path\)/);
  assert.match(browser, /\^#L\(\[1-9\]/);
  assert.doesNotMatch(browser, /window\.history\.(?:pushState|replaceState)/);
  assert.match(browser, /replace: mode === "replace"/);
  assert.match(browser, /location\.hash/);
  assert.match(browser, /location\.search/);
  assert.match(browser, /writeSourceLocation\(nextPath, null, "push"\)/);
});

test("Source line targets survive asynchronous CodeView publication", () => {
  assert.match(browser, /selectedLines=\{selectedLines\}/);
  assert.match(browser, /onSelectedLinesChange=\{handleSelectedLinesChange\}/);
  assert.doesNotMatch(browser, /codeViewRef\.current\?\.setSelectedLines/);
  assert.match(browser, /type: "range"[\s\S]*?behavior: "instant"/);
  assert.match(browser, /observePierreCodeScrollRegions\(container, applyLineTarget\)/);
  assert.match(pierre, /onPublish\?\.\(\)/);
});

test("Source retains completed code, separates unsupported files, and retries requests", () => {
  const catchBody = browser.slice(browser.indexOf(".catch((error: unknown)"), browser.indexOf("const applyLineTarget"));
  assert.doesNotMatch(catchBody, /setLoaded\(null\)/);
  assert.match(browser, /kind: "request" \| "unsupported"/);
  assert.match(browser, /not \(\?:a text file\|available as published text\)/);
  assert.match(browser, /setLoadAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(browser, /fileError && loaded/);
});

test("Source uses one Pierre search and a viewport-sized monochrome tree", () => {
  assert.match(browser, /openFileSearch: openTreeSearch/);
  assert.doesNotMatch(browser, /fuzzyScore|fileSearchOpen|fileSearchResults/);
  assert.match(browser, /icons: \{ set: "standard", colored: false \}/);
  assert.match(browser, /initialVisibleRowCount/);
  assert.match(browser, /observeMediaQueryMatch\([\s\S]*?COARSE_POINTER_QUERY/);
  assert.match(browser, /useResponsiveFileTree\(\{/);
  assert.match(browser, /sourceTreeItemHeight\(coarsePointer\), directoryPaths/);
  assert.match(browser, /retainedSourceTreeState\(previous, directoryPaths\)/);
  assert.match(browser, /captureSourceTreeDomState\(previous, itemHeight\)/);
  assert.match(browser, /restoreSourceTreeDomState\(model, pending\)/);
  assert.match(browser, /modalOpen && !model\.isSearchOpen\(\)/);
  assert.match(browser, /const modelRef = useRef\(model\)/);
  assert.match(browser, /const closeTree = useCallback\(\(\) => \{[\s\S]*?modelRef\.current\.closeSearch\(\)[\s\S]*?\}, \[\]\)/);
  assert.doesNotMatch(browser, /key=\{coarsePointer \? "coarse" : "fine"\}/);
  assert.match(browser, /overscan: 10/);
  assert.match(styles, /--trees-bg-override:\s*transparent/);
  assert.match(styles, /--trees-selected-bg-override:\s*color-mix/);
  assert.match(styles, /--trees-focus-ring-width-override:\s*1px/);
  assert.match(styles, /--trees-font-family-override:\s*var\(--font-mono\)/);
  assert.match(styles, /--trees-font-size-override:\s*11px/);
  assert.doesNotMatch(styles, /box-shadow:\s*var\(--shadow-overlay\)/);
});

test("the Source worker remains single-threaded with a bounded responsive cache", () => {
  assert.match(provider, /poolSize: 1/);
  assert.match(provider, /matchMedia\(COMPACT_WORKSPACE_QUERY\)\.matches \? 10 : 100/);
  assert.match(provider, /preferredHighlighter: "shiki-js"/);
  assert.match(provider, /preloadPierreWorker/);
  assert.match(provider, /PRELOADED_WORKER_RETENTION_MS = 30_000/);
  assert.match(provider, /preloadedWorkerExpiry !== expiry/);
  assert.match(provider, /preloadedWorker\?\.terminate\(\)/);
  assert.match(provider, /createDiffWorker[\s\S]*?clearTimeout\(preloadedWorkerExpiry\)/);
  assert.match(provider, /const worker = preloadedWorker \?\? new DiffWorker\(\)/);
  assert.match(provider, /workerFactory: createDiffWorker/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
