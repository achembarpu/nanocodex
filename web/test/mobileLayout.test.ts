import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexCss = source("../src/index.css");
const terminalCss = source("../src/AgentTerminal.css");
const homeCss = source("../src/Home.css");
const sourceBrowserCss = source("../src/SourceBrowser.css");
const commitsCss = source("../src/Commits.css");
const docsCss = source("../src/Docs.css");
const evalsCss = source("../src/evals.css");
const application = source("../src/NanocodexApp.tsx");
const artifactRuntime = source("../src/artifactRuntime.tsx");
const terminal = source("../src/AgentTerminal.tsx");
const terminalCommands = source("../src/nanocodex.ts");
const mpp = source("../src/MppControls.tsx");
const worker = source("../src/agent.worker.ts");
const compactQuery = "(max-width: 740px), (pointer: coarse) and (orientation: landscape) and (max-width: 950px)";
const coarseQuery = "(pointer: coarse), (any-pointer: coarse)";

test("terminal and application controls share the compact phone policy", () => {
  assert.ok(indexCss.includes(`@media ${compactQuery} {`));
  assert.ok(terminalCss.includes(`@media ${compactQuery} {`));
  const compact = terminalCss.indexOf(`@media ${compactQuery}`);
  const auth = ruleBlock(terminalCss, ".agent-session-bar,", compact);
  const shell = ruleBlock(terminalCss, ".agent-terminal-shell {", compact);
  const previewShell = ruleBlock(
    terminalCss,
    ".nanocodex-demo.is-preview .agent-terminal-shell {",
    compact,
  );
  assert.match(auth, /min-height:\s*44px/);
  assert.match(shell, /100dvh/);
  assert.match(shell, /min-height:\s*280px/);
  assert.match(previewShell, /env\(safe-area-inset-bottom\)/);
});

test("the shared phone header stays in one compact row on every surface", () => {
  const phone = indexCss.indexOf("@media (max-width: 740px) {", indexCss.indexOf("@media (max-width: 1023px)"));
  const header = ruleBlock(indexCss, ".site-header {", phone);
  assert.match(header, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(header, /grid-template-rows:\s*48px/);
  assert.match(header, /height:\s*var\(--mobile-header-height\)/);
  assert.doesNotMatch(indexCss, /\.surface-code \.header-actions/);
  assert.doesNotMatch(indexCss, /\.surface-commits \.header-actions/);
});

test("360px headers retain scrollable alphabetic navigation without clipping the actions", () => {
  const narrow = indexCss.indexOf("@media (max-width: 420px)");
  assert.notEqual(narrow, -1);
  assert.match(ruleBlock(indexCss, ".wordmark {", narrow), /font-size:\s*10px/);
  assert.match(ruleBlock(indexCss, ".surface-switch {", narrow), /gap:\s*0/);
  assert.match(ruleBlock(indexCss, ".surface-switch a {", narrow), /min-width:\s*44px/);
  assert.match(ruleBlock(indexCss, ".surface-label {", narrow), /font-size:\s*0/);
  assert.match(ruleBlock(indexCss, ".surface-key {", narrow), /font-size:\s*10px/);
  assert.match(ruleBlock(indexCss, ".header-install-trigger {", narrow), /width:\s*44px/);
  assert.match(ruleBlock(indexCss, ".header-install-trigger span {", narrow), /display:\s*none/);
});

test("portrait commits still collapse to an in-viewport viewer column", () => {
  const mobile = lastRuleBlock(indexCss, ".commits-workspace {");
  assert.match(mobile, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(mobile, /grid-template-areas:\s*"header"\s*"viewer"/);
});

test("the Source drawer is modal, scroll-locked, and touch-sized", () => {
  const sourceBrowser = source("../src/CodeBrowser.tsx");
  assert.match(sourceBrowser, /role=\{modalOpen \? "dialog" : "complementary"\}/);
  assert.match(sourceBrowser, /aria-modal=\{modalOpen \? true : undefined\}/);
  assert.match(sourceBrowser, /inert=\{modalOpen \? true : undefined\}/);
  assert.match(sourceBrowser, /root\.style\.overflow = "hidden"/);
  assert.match(sourceBrowser, /root\.style\.overscrollBehavior = "none"/);
  assert.match(sourceBrowser, /body\.style\.overflow = "hidden"/);
  assert.match(sourceBrowser, /focusableElements\(panel\)/);
  assert.match(sourceBrowser, /treeOpenerRef\.current\?\.focus\(\)/);
  assert.match(sourceBrowser, /event\.key === "Escape"/);
  assert.match(sourceBrowserCss, /\.source-browser \.source-tree-toolbar button,[\s\S]*?min-width:\s*44px/);
  assert.match(sourceBrowserCss, /\.source-browser \.code-file-tail-error button,[\s\S]*?min-height:\s*44px/);
});

test("the phone home surface leads directly from thesis to install, metadata, and agent", () => {
  const phone = terminalCss.lastIndexOf("@media (max-width: 740px) {");
  const intro = application.indexOf('<header className="home-intro"');
  const homepage = application.slice(intro, application.indexOf("</article>", intro));
  assert.ok(application.indexOf('id="home-title"') < application.indexOf('id="agent-demo"'));
  assert.ok(application.indexOf("High-performance Codex SDK. Runs anywhere.") < application.indexOf('className="home-install"'));
  assert.ok(application.indexOf("curl -fsSL https://nanocodex.paradigm.xyz | bash") < application.indexOf('className="home-meta"'));
  assert.ok(application.indexOf('className="home-meta"') < application.indexOf('id="agent-demo"'));
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
  assert.match(application, /live agent · browser WASM/);
  assert.match(application, /optimized WASM · 1\.3 MB gzip/);
  assert.match(application, /Terminal-Bench 2\.1 high: Nanocodex 82\.2% vs Codex 79\.6% · 890\/890 runs/);
  assert.match(application, /href="\/evals\/worksets\/e1c16fd7df8f171e69052a66cb59b8bd52bc43017297d748eb19866e7593570d"/);
  assert.doesNotMatch(homepage, /retained proof|39\/39 gates|13\/20 verifier passes|Frozen Terminal-Bench|experimental/i);
  assert.match(homeCss, /\.home-install code[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(homeCss, /\.home-proof|\.home-summary|\.home-evidence|\.home-facts|\.home-surfaces|\.home-divider/);
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
  assert.match(terminal, /if \(latest\.current\.mode === "full" && !touchInput\) terminal\.focus\(\)/);
  assert.match(terminal, /if \(mode === "full" && !touchInput\) terminal\.focus\(\)/);
  assert.match(terminal, /aria-label", "Nanocodex terminal input"/);
  assert.match(terminal, /type: "terminalInput"/);
  assert.match(terminal, /type: "terminalResize"/);
  assert.match(terminal, /terminal\.rows - 3/);
  assert.doesNotMatch(terminal, /\\r\\n\\r\\n> /);
});

test("touch terminals use a native IME-safe composer and typed commands", () => {
  assert.match(terminal, /TOUCH_INPUT_QUERY = "\(pointer: coarse\), \(any-pointer: coarse\)"/);
  assert.match(terminal, /<textarea[\s\S]*?aria-label="Message Nanocodex"/);
  assert.match(terminal, /value=\{draft\}[\s\S]*?onChange=\{\(event\) => onChange\(event\.currentTarget\.value\)\}/);
  assert.match(terminal, /onCompositionStart=\{\(\) => \{ composing\.current = true; \}\}/);
  assert.match(terminal, /isTerminalSubmitKeyEvent\(event\.nativeEvent, composing\.current\)/);
  assert.match(terminal, /onSubmit\(draft, running \? "steer" : "queue"\)/);
  assert.match(terminal, />Stop<\/button>/);
  assert.match(terminal, /running \? "Steer" : "Send"/);
  assert.match(terminal, />│<\/span>/);
  assert.doesNotMatch(terminal, /\x1b\[200~|bracketed-paste/i);

  const touchCss = terminalCss.indexOf("@media (pointer: coarse), (any-pointer: coarse)");
  assert.notEqual(touchCss, -1);
  assert.match(ruleBlock(terminalCss, ".agent-touch-composer textarea {", touchCss), /font:\s*400 16px/);
  assert.match(ruleBlock(terminalCss, ".agent-touch-actions button {", touchCss), /min-height:\s*44px/);
  const composer = ruleBlock(terminalCss, ".agent-touch-composer {", touchCss);
  assert.match(composer, /position:\s*relative/);
  assert.match(composer, /min-height:\s*calc\(60px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(composer, /env\(safe-area-inset-left\)/);
  assert.match(composer, /env\(safe-area-inset-right\)/);
  assert.match(terminalCommands, /type: "terminalSubmit"; input: string; intent: "queue" \| "steer"/);
  assert.match(terminalCommands, /type: "terminalCancel"/);
  assert.match(worker, /attachedTerminal\?\.submit\(data\.input, \{ intent: data\.intent \}\)/);
  assert.match(worker, /attachedTerminal\?\.cancel\(\)/);
});

test("touch terminal geometry follows the visual viewport without weakening hidden focus", () => {
  assert.match(terminal, /const viewport = window\.visualViewport/);
  assert.match(terminal, /viewport\?\.addEventListener\("resize", measure\)/);
  assert.match(terminal, /viewport\?\.addEventListener\("scroll", measure\)/);
  assert.match(terminal, /window\.addEventListener\("orientationchange", measure\)/);
  assert.match(terminal, /root\.style\.height = `\$\{available\}px`/);
  assert.match(terminal, /shell\.style\.height = `\$\{Math\.min\(naturalHeight, shellAvailable\)\}px`/);
  assert.match(terminalCss, /\.nanocodex-demo\.is-full \.agent-terminal-shell:focus-within/);
  const touchCss = terminalCss.indexOf("@media (pointer: coarse), (any-pointer: coarse)");
  assert.match(ruleBlock(terminalCss, ".agent-terminal-shell {", touchCss), /grid-template-rows:\s*minmax\(0, 1fr\) auto/);
  assert.match(
    ruleBlock(terminalCss, ".nanocodex-demo.is-preview .agent-terminal-shell:focus-within,", touchCss),
    /min-height:\s*120px/,
  );
  assert.match(terminal, /host\.parentElement\?\.contains\(window\.document\.activeElement\)/);
  assert.match(terminal, /textarea\.readOnly = touchInput/);
  assert.match(terminal, /textarea\.tabIndex = touchInput \? -1 : 0/);
});

test("terminal frames survive a Worker/xterm startup race", () => {
  assert.match(terminal, /const pendingTerminalFrame = useRef<string \| undefined>\(undefined\)/);
  assert.match(terminal, /pendingTerminalFrame\.current = message\.data/);
  assert.match(
    terminal,
    /if \(pendingTerminalFrame\.current !== undefined\) \{[\s\S]*?instance\.write\(pendingTerminalFrame\.current\)[\s\S]*?pendingTerminalFrame\.current = undefined/,
  );
});

test("the Worker hosts the reusable terminal adapter", () => {
  assert.match(worker, /createAgentTerminal/);
  assert.match(worker, /type: "terminalWrite"/);
  assert.match(worker, /terminalHost\?\.input/);
  assert.match(worker, /terminalHost\?\.resize/);
  assert.match(worker, /type: "terminalActivity", running: activePromptIds\.size > 0/);
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
  const brand = ruleBlock(indexCss, ".site-brand {", phone);
  const install = ruleBlock(indexCss, ".header-install-trigger {", phone);
  assert.match(switcher, /padding:\s*0/);
  assert.match(surfaces, /min-height:\s*44px/);
  assert.match(brand, /min-height:\s*44px/);
  assert.match(install, /min-height:\s*44px/);
});

test("portrait coarse-pointer tablets retain 44px controls without changing layout", () => {
  for (const [css, selector] of [
    [indexCss, ".header-install-trigger,"],
    [terminalCss, ".agent-session-bar,"],
    [sourceBrowserCss, ".source-browser .source-tree-toolbar button {"],
    [commitsCss, ".commits-workspace .commit-scope-tabs button,"],
    [evalsCss, ".eval-back,"],
    [docsCss, ".docs-sidebar a,"],
  ] as const) {
    const coarse = css.indexOf(`@media ${coarseQuery}`);
    assert.notEqual(coarse, -1, selector);
    assert.match(ruleBlock(css, selector, coarse), /min-height:\s*44px/, selector);
  }
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
