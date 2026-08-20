import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexCss = source("../src/index.css");
const terminalCss = source("../src/AgentTerminal.css");
const homeCss = source("../src/Home.css");
const application = source("../src/NanocodexApp.tsx");
const artifactRuntime = source("../src/artifactRuntime.tsx");
const terminal = source("../src/AgentTerminal.tsx");
const mpp = source("../src/MppControls.tsx");
const worker = source("../src/agent.worker.ts");
const compactQuery = "(max-width: 740px), (pointer: coarse) and (orientation: landscape) and (max-width: 950px)";

test("terminal and application controls share the compact phone policy", () => {
  assert.ok(indexCss.includes(`@media ${compactQuery} {`));
  assert.ok(terminalCss.includes(`@media ${compactQuery} {`));
  const compact = terminalCss.indexOf(`@media ${compactQuery}`);
  const auth = ruleBlock(terminalCss, ".agent-session-bar,", compact);
  const shell = ruleBlock(terminalCss, ".agent-terminal-shell {", compact);
  assert.match(auth, /min-height:\s*44px/);
  assert.match(shell, /100dvh/);
  assert.match(shell, /env\(safe-area-inset-bottom\)/);
  assert.match(shell, /min-height:\s*280px/);
});

test("the shared phone header stays in one compact row on every surface", () => {
  const phone = indexCss.indexOf("@media (max-width: 740px) {", indexCss.indexOf("@media (max-width: 1023px)"));
  const header = ruleBlock(indexCss, ".site-header {", phone);
  assert.match(header, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(header, /grid-template-rows:\s*64px/);
  assert.match(header, /height:\s*var\(--mobile-header-height\)/);
  assert.doesNotMatch(indexCss, /\.surface-code \.header-actions/);
  assert.doesNotMatch(indexCss, /\.surface-commits \.header-actions/);
});

test("portrait commits still collapse to an in-viewport viewer column", () => {
  const mobile = lastRuleBlock(indexCss, ".commits-workspace {");
  assert.match(mobile, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(mobile, /grid-template-areas:\s*"header"\s*"viewer"/);
});

test("the phone home surface explains the live agent before mounting it", () => {
  const phone = terminalCss.lastIndexOf("@media (max-width: 740px) {");
  assert.ok(application.indexOf('id="home-title"') < application.indexOf('id="agent-demo"'));
  assert.ok(application.indexOf('id="agent-demo-title"') < application.indexOf("<AgentTerminal"));
  assert.ok(phone < 0, "the compact terminal policy is shared across phone orientations");
  assert.match(application, /<AgentTerminal[\s\S]*?mode=\{[\s\S]*?"full"[\s\S]*?"preview"[\s\S]*?"hidden"[\s\S]*?theme=\{theme\}/);
  assert.equal(matches(application, /<AgentTerminal\b/g), 1);
  assert.match(application, /hidden=\{surface !== "home" && surface !== "agent"\}/);
  assert.match(application, /inert=\{surface !== "home" && surface !== "agent" \? true : undefined\}/);
  assert.match(terminal, /<XtermSurface/);
  assert.match(terminal, /theme=\{theme\}/);
  assert.match(terminal, /instance\.current\.options\.theme = terminalTheme\(theme\)/);
  assert.match(terminalCss, /--terminal-background:\s*var\(--surface\)/);
  assert.match(homeCss, /\.home-facts article > h2/);
  assert.match(homeCss, /\.home-facts article > p/);
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
  assert.match(terminal, /new ResizeObserver\(\(\) => \{[\s\S]*?fit\.fit\(\)/);
  assert.match(terminal, /if \(latest\.current\.mode === "full"\) terminal\.focus\(\)/);
  assert.match(terminal, /if \(mode === "full"\) terminal\.focus\(\)/);
  assert.match(terminal, /aria-label", "Nanocodex terminal input"/);
  assert.match(terminal, /type: "terminalInput"/);
  assert.match(terminal, /type: "terminalResize"/);
  assert.match(terminal, /terminal\.rows - 3/);
  assert.doesNotMatch(terminal, /\\r\\n\\r\\n> /);
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
  assert.match(ruleBlock(terminalCss, ".agent-session-actions button,", terminalCss.indexOf(`@media ${compactQuery}`)), /min-height:\s*44px/);

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

test("the default terminal chrome stays generic while advanced connection paths remain available", () => {
  assert.doesNotMatch(terminal, /Connected to your ChatGPT subscription/);
  assert.doesNotMatch(terminal, /The agent runs in your browser/);
  assert.match(terminal, /aria-live="polite"/);
  assert.match(terminal, /aria-label="Connection options">session/);
  assert.match(terminal, /aria-label="Use ChatGPT subscription"/);
  assert.match(terminal, /aria-label="Use Tempo MPP"/);
  assert.match(terminal, /aria-pressed=\{transport === "openai"\}/);
  assert.match(terminal, /aria-pressed=\{transport === "mpp"\}/);
  assert.match(mpp, /<details className="agent-payment-details">/);
  assert.match(mpp, /<summary>payment details<\/summary>/);
  for (const capability of ["authorize", "add funds", "disconnect", "Tempo account", "Model authorized", "Mercator authorized"]) {
    assert.match(mpp, new RegExp(capability, "i"));
  }
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

function matches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}
