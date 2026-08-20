import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexCss = source("../src/index.css");
const terminalCss = source("../src/AgentTerminal.css");
const application = source("../src/NanocodexApp.tsx");
const artifactRuntime = source("../src/artifactRuntime.tsx");
const terminal = source("../src/AgentTerminal.tsx");
const worker = source("../src/agent.worker.ts");
const compactQuery = "(max-width: 740px), (pointer: coarse) and (orientation: landscape) and (max-width: 950px)";

test("terminal and application controls share the compact phone policy", () => {
  assert.ok(indexCss.includes(`@media ${compactQuery} {`));
  assert.ok(terminalCss.includes(`@media ${compactQuery} {`));
  const compact = terminalCss.indexOf(`@media ${compactQuery}`);
  const auth = ruleBlock(terminalCss, ".agent-transport {", compact);
  const shell = ruleBlock(terminalCss, ".agent-terminal-shell {", compact);
  assert.match(auth, /grid-template-columns:\s*1fr 1fr/);
  assert.match(shell, /100dvh/);
  assert.match(shell, /env\(safe-area-inset-bottom\)/);
  assert.match(shell, /min-height:\s*440px/);
});

test("portrait commits still collapse to an in-viewport viewer column", () => {
  const mobile = lastRuleBlock(indexCss, ".commits-workspace {");
  assert.match(mobile, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(mobile, /grid-template-areas:\s*"header"\s*"viewer"/);
});

test("the phone home surface explains the live agent before mounting it", () => {
  const phone = terminalCss.lastIndexOf("@media (max-width: 740px) {");
  assert.ok(application.indexOf('id="home-title"') < application.indexOf('id="agent-demo"'));
  assert.ok(application.indexOf('id="agent-demo-title"') < application.indexOf("<AgentTerminal />"));
  assert.doesNotMatch(terminalCss.slice(phone), /\.agent-auth-privacy\s*\{[^}]*display:\s*none/);
  assert.match(terminal, /<XtermSurface/);
  assert.doesNotMatch(terminal, /<NanocodexTui|<WorkspacePanel|<ArtifactDock/);
});

test("the terminal survives deployment rollover and discarded mobile workers", () => {
  assert.match(terminal, /event\.persisted/);
  assert.match(terminal, /sha !== deploymentSha/);
  assert.match(terminal, /window\.location\.reload\(\)/);
  assert.match(terminal, /workerRecoveryAttempts\.current >= 2/);
  assert.match(terminal, /nanocodexConfig\.restart\(startCommand\(nextTransport, thread\.id\)\)/);
});

test("terminal interaction is renderer-neutral and resize-driven", () => {
  assert.match(terminal, /new Xterm\(/);
  assert.match(terminal, /new FitAddon\(\)/);
  assert.match(terminal, /encodeXtermKeyEvent/);
  assert.match(terminal, /new ResizeObserver\(\(\) => fit\.fit\(\)\)/);
  assert.match(terminal, /aria-label", "Nanocodex terminal input"/);
  assert.match(terminal, /type: "terminalInput"/);
  assert.match(terminal, /type: "terminalResize"/);
});

test("the Worker hosts the reusable terminal adapter", () => {
  assert.match(worker, /createAgentTerminal/);
  assert.match(worker, /type: "terminalWrite"/);
  assert.match(worker, /terminalHost\?\.input/);
  assert.match(worker, /terminalHost\?\.resize/);
});

test("the artifact runtime remains independently scrollable", () => {
  assert.ok(artifactRuntime.includes('document.documentElement.classList.add("artifact-runtime-page")'));
  assert.match(indexCss, /\.artifact-runtime-page body \{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-y:\s*auto;[\s\S]*?\}/);
});

test("phone auth controls and other application targets meet mobile baselines", () => {
  assert.ok(terminalCss.includes(".agent-byok input {\n    font-size: 16px;"));
  assert.match(ruleBlock(terminalCss, ".agent-transport button,", terminalCss.indexOf(`@media ${compactQuery}`)), /min-height:\s*44px/);

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
