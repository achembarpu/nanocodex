import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const codeBrowser = source("../src/CodeBrowser.tsx");
const commitStream = source("../src/CommitCodeStream.tsx");
const diffViewer = source("../src/DiffsHubViewer.tsx");
const evalAnalytics = source("../src/EvalAnalytics.tsx");
const evals = source("../src/LiveEvals.tsx");
const application = source("../src/NanocodexApp.tsx");
const pierreCodeView = source("../src/pierreCodeView.ts");

test("source and commit workspaces expose headings and keyboard-scrollable code", () => {
  assert.match(codeBrowser, /<h1 className="sr-only">Nanocodex source code<\/h1>/);
  assert.match(application, /<h1 className="sr-only">Nanocodex repository commits<\/h1>/);
  assert.match(codeBrowser, /container\.tabIndex = 0/);
  assert.match(diffViewer, /container\.tabIndex = 0/);
  assert.match(codeBrowser, /observePierreCodeScrollRegions\(container, applyLineTarget\)/);
  assert.match(diffViewer, /observePierreCodeScrollRegions\(container\)/);
  assert.match(pierreCodeView, /column\.tabIndex = 0/);
  assert.match(pierreCodeView, /new MutationObserver\(exposeDiffs\)/);
  assert.match(pierreCodeView, /container\.contains\(root\.host\)/);
  assert.match(pierreCodeView, /\[data-code\]:focus-visible/);
  assert.match(codeBrowser, /aria-label="Search repository files"/);
});

test("the Source tree exposes only Pierre's virtualized rows as the ARIA tree", () => {
  assert.match(codeBrowser, /root\.removeAttribute\("role"\)/);
  assert.match(codeBrowser, /rows\.setAttribute\("role", "tree"\)/);
  assert.match(codeBrowser, /rows\.setAttribute\("aria-label", "Repository files"\)/);
  assert.match(codeBrowser, /searchInput\.setAttribute\("aria-label", "Search repository files"\)/);
  assert.match(codeBrowser, /searchInput\.setAttribute\("aria-controls", rowsId\)/);
  assert.doesNotMatch(codeBrowser, /new MutationObserver\(exposeVirtualizedRows\)/);
  assert.match(codeBrowser, /<header className="pierre-tree-heading source-tree-toolbar">/);
  assert.match(codeBrowser, /<FileTree[\s\S]*?model=\{model\}[\s\S]*?style=\{treeTheme\}/);
  assert.doesNotMatch(codeBrowser, /<FileTree[\s\S]*?header=/);
  assert.match(codeBrowser, /themeToTreeStyles/);
  assert.match(codeBrowser, /role="group"[\s\S]*?File path:/);
});

test("mobile commit overlays own focus, background interaction, and scroll", () => {
  assert.match(application, /role=\{commitRailModalOpen \? "dialog" : "complementary"\}/);
  assert.match(application, /aria-modal=\{commitRailModalOpen \? true : undefined\}/);
  assert.match(application, /inert=\{commitModalOpen \? true : undefined\}/);
  assert.match(application, /inert=\{commitSearchModalOpen \? true : undefined\}/);
  assert.match(application, /root\.style\.overflow = "hidden"/);
  assert.match(application, /root\.style\.overscrollBehavior = "none"/);
  assert.match(application, /body\.style\.overflow = "hidden"/);
  assert.match(application, /new MutationObserver\(inertBackground\)/);
  assert.match(application, /containModalFocus\(event, commitRailRef\.current\)/);
  assert.match(application, /containModalFocus\(event, searchDialogRef\.current\)/);
  assert.match(application, /restoreModalFocus\(commitRailOpenerRef\)/);
  assert.match(application, /restoreModalFocus\(searchOpenerRef\)/);
  assert.match(application, /commitRailCloseRef\.current\?\.focus\(\)/);
  assert.match(application, /searchInputRef\.current\?\.focus\(\)/);
  assert.match(commitStream, /aria-controls="commit-index"/);
  assert.match(commitStream, /aria-expanded=\{commitRailOpen \?\? false\}/);
});

test("eval legends use named groups instead of labels on generic elements", () => {
  assert.match(evalAnalytics, /className="eval-run-legend" role="group"/);
  assert.match(evals, /className="eval-matrix-legend" role="group"/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
