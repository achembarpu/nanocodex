import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexCss = source("../src/index.css");
const terminalCss = source("../src/AgentTerminal.css");
const application = source("../src/NanocodexApp.tsx");
const artifactDock = source("../src/ArtifactDock.tsx");
const artifactRuntime = source("../src/artifactRuntime.tsx");
const terminal = source("../src/AgentTerminal.tsx");
const tui = source("../../js/tui-react/src/NanocodexTui.tsx");
const tuiCss = source("../../js/tui-react/structure.css");
const compactQuery = "(max-width: 740px), (pointer: coarse) and (orientation: landscape) and (max-width: 950px)";

test("compact workspace policy includes portrait and coarse landscape phones", () => {
  assert.ok(artifactDock.includes(`COMPACT_WORKSPACE_MEDIA_QUERY = ${JSON.stringify(compactQuery)}`));
  assert.ok(indexCss.includes(`@media ${compactQuery} {`));
  assert.ok(terminalCss.includes(`@media ${compactQuery} {`));
  assert.ok(tuiCss.includes(`@media ${compactQuery} {`));
  assert.match(artifactDock, /const \[fullscreen, setFullscreen\] = useState\(false\)/);
  assert.match(artifactDock, /if \(compact\.matches\) setFullscreen\(false\)/);
  assert.match(artifactDock, /setFullscreen\(!compactWorkspace\(\)\)/);
});

test("portrait commits collapse to an in-viewport viewer column", () => {
  const mobile = lastRuleBlock(indexCss, ".commits-workspace {");
  assert.match(mobile, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(mobile, /grid-template-areas:\s*"header"\s*"viewer"/);
});

test("compact workspace removes the phantom header offset and fixed height floor", () => {
  const nav = ruleBlock(terminalCss, ".agent-mobile-nav", terminalCss.indexOf(`@media ${compactQuery}`));
  const shell = ruleBlock(terminalCss, ".agent-workspace-shell,", terminalCss.indexOf(`@media ${compactQuery}`));
  assert.match(nav, /top:\s*0/);
  assert.match(nav, /min-height:\s*44px/);
  assert.match(shell, /height:\s*calc\(var\(--nc-mobile-workspace-height,\s*calc\(100dvh - 50px\)\) - env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(shell, /max\(480px/);
});

test("the phone home surface explains the live agent before mounting it", () => {
  const phone = terminalCss.lastIndexOf("@media (max-width: 740px) {");
  assert.ok(application.indexOf('id="home-title"') < application.indexOf('id="agent-demo"'));
  assert.ok(application.indexOf('id="agent-demo-title"') < application.indexOf("<AgentTerminal />"));
  assert.doesNotMatch(terminalCss.slice(phone), /\.agent-auth-privacy\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(terminalCss.slice(phone), /\.home-demo\s*\{[^}]*order:\s*-1/);

  const shell = ruleBlock(terminalCss, ".agent-workspace-shell,", phone);
  assert.match(shell, /--nc-mobile-workspace-height/);
  assert.match(shell, /100dvh - var\(--mobile-header-height\) - 172px/);
});

test("mobile interaction follows the visual viewport and exposes touch actions", () => {
  assert.match(terminal, /window\.visualViewport/);
  assert.match(terminal, /--nc-mobile-workspace-height/);
  assert.match(tui, /matchMedia\("\(pointer: coarse\)"\)/);
  assert.match(tui, /className="agent-tui-mobile-only"[\s\S]*?>Stop<\/button>/);
  assert.match(tui, /conversation\.running \? "Steer" : "Send"/);
  assert.match(terminal, /event\.persisted/);
  assert.match(terminal, /sha !== deploymentSha/);
  assert.match(terminal, /window\.location\.reload\(\)/);
  assert.match(terminal, /workerRecoveryAttempts\.current >= 2/);
  assert.match(terminal, /nanocodexConfig\.restart\(startCommand\(nextTransport, thread\.id\)\)/);
  const compact = tuiCss.indexOf(`@media ${compactQuery}`);
  const actions = ruleBlock(tuiCss, ".agent-tui-mobile-actions {", compact);
  assert.match(actions, /display:\s*flex/);
  assert.match(actions, /gap:\s*6px/);
});

test("mobile actions wait for the active branch session generation", () => {
  assert.match(
    tui,
    /const target = activeTarget\(tui\);\s+const ready = workerStatus === "ready" && Boolean\(sessionIdForTarget\(tui, target\)\)/,
  );
  assert.match(tui, /if \(workerStatus !== "ready" \|\| !sessionId\)/);
  assert.match(
    tui,
    /if \(workerStatus !== "ready" \|\| !sessionIdForTarget\(tui, inputTarget\)\)/,
  );
  assert.match(
    terminal,
    /key=\{`\$\{transport\}:\$\{credentialSource \?\? "signed-out"\}`\}/,
  );
});

test("short compact workspaces keep transcript, composer, and file controls in their grids", () => {
  const compact = tuiCss.indexOf(`@media ${compactQuery}`);
  const tui = ruleBlock(tuiCss, ".agent-tui {", compact);
  const pending = ruleBlock(tuiCss, ".agent-tui-pending {", compact);
  assert.match(tui, /grid-template-rows:\s*22px minmax\(0,\s*1fr\) minmax\(0,\s*max-content\) auto 22px/);
  assert.match(pending, /overflow-y:\s*auto/);

  const mobile = terminalCss.indexOf(`@media ${compactQuery}`);
  const tree = ruleBlock(terminalCss, ".workspace-tree {", mobile);
  const editor = ruleBlock(terminalCss, ".workspace-editor {", mobile);
  assert.match(tree, /min-height:\s*0/);
  assert.match(editor, /grid-template-rows:\s*28px minmax\(0,\s*1fr\) minmax\(44px,\s*auto\)/);
  assert.match(editor, /min-height:\s*0/);
});

test("compact artifacts reserve their header row and allow iframe documents to scroll", () => {
  const mobile = terminalCss.indexOf(`@media ${compactQuery}`);
  const dock = ruleBlock(terminalCss, ".agent-workspace-shell > .artifact-dock,", mobile);
  assert.match(dock, /grid-template-rows:\s*minmax\(46px,\s*auto\) minmax\(0,\s*1fr\) auto/);
  assert.ok(artifactRuntime.includes('document.documentElement.classList.add("artifact-runtime-page")'));
  assert.match(indexCss, /\.artifact-runtime-page body \{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-y:\s*auto;[\s\S]*?\}/);
  assert.doesNotMatch(artifactDock, /body \{ overflow:\s*hidden; \}/);
});

test("phone text controls and prioritized touch targets meet mobile baselines", () => {
  for (const declaration of [
    ".workspace-editor textarea { font-size: 16px; }",
    ".workspace-tree-item { min-height: 44px; height: auto; }",
    ".artifact-dock-header button { width: 44px; height: 44px; }",
    ".artifact-preview-button { min-height: 44px; }",
  ]) assert.ok(terminalCss.includes(declaration), declaration);

  for (const declaration of [
    "min-width: 52px;\n    height: 44px;",
    ".agent-tui-composer {\n    min-height: 52px !important;",
    ".agent-tui-editor textarea {\n    font-size: 16px;",
  ]) assert.ok(tuiCss.includes(declaration), declaration);

  for (const selector of [
    ".pierre-tree-heading button",
    ".mobile-tree-toggle",
    ".mobile-drawer-close",
    ".code-file-search",
    ".commit-view-button",
    ".commit-query button",
    ".commit-indicator-options button",
  ]) {
    const block = lastRuleBlock(indexCss, `${selector} {`);
    assert.match(block, /(?:width|min-width|min-height|height):\s*44px/, selector);
  }
  assert.ok(indexCss.includes(".commit-display-menu-item,\n  .commit-setting-row {\n    min-height: 44px;"));

  const phone = indexCss.indexOf("@media (max-width: 740px) {", indexCss.indexOf("@media (max-width: 1023px)"));
  const switcher = ruleBlock(indexCss, ".surface-switch {", phone);
  const surfaces = ruleBlock(indexCss, ".surface-switch a {", phone);
  const theme = ruleBlock(indexCss, ".header-actions .text-action {", phone);
  assert.match(switcher, /padding:\s*0/);
  assert.match(surfaces, /min-height:\s*44px/);
  assert.match(theme, /width:\s*44px/);
  assert.match(theme, /min-height:\s*44px/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function lastRuleBlock(css: string, selector: string): string {
  const start = css.lastIndexOf(selector);
  assert.notEqual(start, -1, `missing ${selector}`);
  return ruleBlock(css, selector, start);
}

function ruleBlock(css: string, selector: string, from: number): string {
  const start = css.indexOf(selector, from);
  assert.notEqual(start, -1, `missing ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(start, close + 1);
}
