import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const codeBrowser = source("../src/CodeBrowser.tsx");
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
  assert.match(diffViewer, /column\.tabIndex = 0/);
  assert.match(diffViewer, /new MutationObserver\(exposeDiffs\)/);
  assert.match(diffViewer, /container\.contains\(root\.host\)/);
  assert.match(pierreCodeView, /\[data-code\]:focus-visible/);
});

test("the Pierre file-tree adapter exposes only file rows as the ARIA tree", () => {
  assert.match(codeBrowser, /treeRoot\.removeAttribute\("role"\)/);
  assert.match(codeBrowser, /treeRows\.setAttribute\("role", "tree"\)/);
  assert.match(codeBrowser, /searchInput\.setAttribute\("aria-controls", rowsId\)/);
  assert.match(codeBrowser, /role="group"[\s\S]*?File path:/);
});

test("eval legends use named groups instead of labels on generic elements", () => {
  assert.match(evalAnalytics, /className="eval-run-legend" role="group"/);
  assert.match(evals, /className="eval-matrix-legend" role="group"/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
