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
const terminalSurface = source("../src/agentTerminalSurface.tsx");
const artifactDock = source("../src/ArtifactDock.tsx");
const modelSession = source("../src/modelSession.tsx");
const docs = source("../src/Docs.tsx");
const modalBoundary = source("../src/modalBoundary.ts");
const modalFrameBoundary = source("../src/useModalFrameBoundary.ts");
const mobileInteraction = source("../src/mobileInteraction.ts");
const deploymentRollover = source("../src/useDeploymentRollover.ts");
const demoTerminal = source("../src/demoTerminal.ts");
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
  assert.match(ruleBlock(indexCss, ".header-center {", narrow), /width:\s*calc\(100% \+ 16px\)/);
  assert.match(ruleBlock(indexCss, ".header-center {", narrow), /margin-inline:\s*-8px/);
  assert.match(ruleBlock(indexCss, ".wordmark {", narrow), /font-size:\s*10px/);
  assert.match(ruleBlock(indexCss, ".surface-switch {", narrow), /gap:\s*0/);
  assert.match(ruleBlock(indexCss, ".surface-switch a {", narrow), /min-width:\s*44px/);
  assert.match(ruleBlock(indexCss, ".surface-label {", narrow), /display:\s*none/);
  assert.match(
    ruleBlock(indexCss, ".surface-switch a::after {", narrow),
    /content:\s*attr\(data-mobile-label\)[\s\S]*?font-size:\s*10px/,
  );
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
  assert.match(sourceBrowser, /useModalBoundary\(\{[\s\S]*?onDismiss: closeTree,[\s\S]*?returnFocusRef: treeOpenerRef/);
  assert.match(sourceBrowser, /fallbackFocusRef: workspaceRef/);
  assert.match(modalBoundary, /createOutsideInertOwner/);
  assert.match(modalBoundary, /rootStyle\.overflow = bodyStyle\.overflow = "hidden"/);
  assert.match(modalBoundary, /rootStyle\.overscrollBehavior = bodyStyle\.overscrollBehavior = "none"/);
  assert.match(modalBoundary, /event\.key === "Escape"/);
  assert.match(sourceBrowserCss, /\.source-browser \.source-tree-toolbar button,[\s\S]*?min-width:\s*44px/);
  assert.match(sourceBrowserCss, /\.source-browser \.code-file-tail-error button,[\s\S]*?min-height:\s*44px/);
});

test("compact Artifact, Source, and Docs overlays share complete modal ownership", () => {
  assert.match(artifactDock, /const modalOpen = compact && !collapsed/);
  assert.match(artifactDock, /role=\{modalOpen \? "dialog" : "complementary"\}/);
  assert.match(artifactDock, /aria-modal=\{modalOpen \? true : undefined\}/);
  assert.match(artifactDock, /className="artifact-dock-backdrop"/);
  assert.match(artifactDock, /useModalBoundary\(\{[\s\S]*?onDismiss: collapse,[\s\S]*?returnFocusRef: toggleRef/);
  assert.match(artifactDock, /useModalFrameBoundary\(\{[\s\S]*?onDismiss: collapse/);
  assert.match(docs, /role="dialog"[\s\S]*?aria-modal="true"/);
  assert.match(docs, /useModalBoundary\(\{[\s\S]*?onDismiss: closeBrowse,[\s\S]*?returnFocusRef: browseButtonRef/);
  assert.match(docs, /fallbackFocusRef: desktopFocusRef/);
  assert.match(modalBoundary, /new MutationObserver\(inertOwner\.refresh\)/);
  assert.match(modalBoundary, /document\.addEventListener\("focusin", onFocusIn, true\)/);
  assert.match(modalFrameBoundary, /frame\.contentWindow !== event\.source/);
  assert.match(modalBoundary, /iframe/);
  assert.match(modalBoundary, /contenteditable/);
  assert.match(modalBoundary, /summary:first-of-type/);
  assert.match(modalBoundary, /orderModalTabSequence/);
  assert.match(modalBoundary, /isRadioTabStop/);
  assert.match(modalBoundary, /contentVisibility !== "hidden"/);
  assert.match(artifactRuntime, /modalFrameBoundaryMessage\("Escape"\)/);
  assert.match(artifactRuntime, /modalFrameTabBoundaryKey\(\{/);
  assert.match(artifactRuntime, /!modalBoundaryActive/);
  assert.match(modalFrameBoundary, /setState\(true\)/);
  assert.match(modalFrameBoundary, /setState\(false\)/);
});

test("the phone home surface leads directly from thesis to install, metadata, and agent", () => {
  const phone = terminalCss.lastIndexOf("@media (max-width: 740px) {");
  const intro = application.indexOf('<header className="home-intro"');
  const homepage = application.slice(intro, application.indexOf("</article>", intro));
  assert.ok(application.indexOf('id="home-title"') < application.indexOf('id="agent-demo"'));
  assert.ok(application.indexOf("High-performance Codex SDK. Runs anywhere.") < application.indexOf('className="home-install"'));
  assert.ok(application.indexOf("curl -fsSL https://nanocodex.paradigm.xyz | bash") < application.indexOf('className="home-meta"'));
  assert.ok(application.indexOf('className="home-meta"') < application.indexOf('id="agent-demo"'));
  assert.ok(application.indexOf('id="agent-demo-title"') < application.indexOf("<AgentExperience"));
  assert.ok(phone < 0, "the compact terminal policy is shared across phone orientations");
  assert.match(application, /<AgentExperience[\s\S]*?mode=\{[\s\S]*?"full"[\s\S]*?"preview"[\s\S]*?"hidden"[\s\S]*?theme=\{theme\}/);
  assert.equal(matches(application, /<AgentExperience\b/g), 1);
  assert.match(application, /hidden=\{surface !== "home" && surface !== "agent"\}/);
  assert.match(application, /inert=\{surface !== "home" && surface !== "agent" \? true : undefined\}/);
  assert.match(terminal, /<XtermSurface/);
  assert.match(terminal, /theme=\{theme\}/);
  assert.match(terminalSurface, /instance\.current\.options\.theme = terminalTheme\(theme\)/);
  assert.match(terminalCss, /--terminal-background:\s*var\(--surface\)/);
  assert.match(application, /live agent · local or durable/);
  assert.match(application, /optimized WASM · 1\.3 MB gzip/);
  assert.match(application, /Terminal-Bench 2\.1 high: Nanocodex 82\.2% vs Codex 79\.6% · 890\/890 runs/);
  assert.match(
    application,
    /const terminalBenchWorksetPath =\s*"\/evals\/worksets\/e1c16fd7df8f171e69052a66cb59b8bd52bc43017297d748eb19866e7593570d"/,
  );
  assert.match(application, /href=\{terminalBenchWorksetPath\}/);
  assert.match(application, /handleEvalPathClick\(event, terminalBenchWorksetPath\)/);
  assert.doesNotMatch(homepage, /retained proof|39\/39 gates|13\/20 verifier passes|Frozen Terminal-Bench|experimental/i);
  assert.match(homeCss, /\.home-install code[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(homeCss, /\.home-proof|\.home-summary|\.home-evidence|\.home-facts|\.home-surfaces|\.home-divider/);
  assert.doesNotMatch(terminal, /<NanocodexTui|<WorkspacePanel/);
  assert.match(terminal, /mode === "full" \? \([\s\S]*?<ArtifactDock[\s\S]*?\) : terminal/);
});

test("the app shell owns deployment rollover and agent failures expose only manual retry", () => {
  assert.match(application, /useDeploymentRollover\(\)/);
  assert.match(deploymentRollover, /event\.persisted/);
  assert.match(deploymentRollover, /sha !== deploymentSha/);
  assert.match(deploymentRollover, /window\.location\.reload\(\)/);
  assert.match(terminal, /refetch\(\)/);
  assert.match(modelSession, /agentStatus === "error" && hasCredential[\s\S]*?>retry agent<\/button>/);
  assert.doesNotMatch(`${terminal}\n${modelSession}`, /automaticRetry|workerRecoveryAttempts/);
  assert.doesNotMatch(terminal, /setTimeout\(/);
  assert.doesNotMatch(terminal, /deployment_sha|pageshow/);
  assert.doesNotMatch(terminal, /createDemoAgent|setRetryGeneration|sessions\.current\.replace/);
});

test("terminal interaction is renderer-neutral and resize-driven", () => {
  assert.match(terminalSurface, /new Xterm\(/);
  assert.match(terminalSurface, /new FitAddon\(\)/);
  assert.match(terminalSurface, /const terminalHost = bufferedXtermAdapter\(terminal\)/);
  assert.match(terminalSurface, /new ResizeObserver\(\(\) => \{[\s\S]*?fit\.fit\(\)/);
  assert.match(terminalSurface, /if \(latest\.current\.mode === "full" && !touchInput\) terminal\.focus\(\)/);
  assert.match(terminalSurface, /if \(mode === "full" && !touchInput\) terminal\.focus\(\)/);
  assert.match(terminalSurface, /aria-label", "Nanocodex terminal input"/);
  assert.match(demoTerminal, /terminal\.onData\(onData\)/);
  assert.match(demoTerminal, /terminal\.onResize\(resize\)/);
  assert.match(terminalSurface, /terminal\.rows - 3/);
  assert.doesNotMatch(terminalSurface, /\\r\\n\\r\\n> /);
});

test("touch terminals use one native IME-safe composer and one contextual action", () => {
  const touchComposer = terminalSurface.slice(
    terminalSurface.indexOf("export function TouchTerminalComposer"),
    terminalSurface.indexOf("export function useTouchInput"),
  );
  assert.match(mobileInteraction, /COARSE_POINTER_QUERY = "\(pointer: coarse\), \(any-pointer: coarse\)"/);
  assert.match(terminalSurface, /window\.matchMedia\(COARSE_POINTER_QUERY\)/);
  assert.equal(matches(terminal, /<TouchTerminalComposer\b/g), 1);
  assert.match(touchComposer, /<textarea[\s\S]*?aria-label="Message Nanocodex"/);
  assert.match(touchComposer, /value=\{draft\}[\s\S]*?onChange=\{\(event\) => onChange\(event\.currentTarget\.value\)\}/);
  assert.match(touchComposer, /onCompositionStart=\{\(\) => \{ composing\.current = true; \}\}/);
  assert.match(touchComposer, /isTerminalSubmitKeyEvent\(event\.nativeEvent, composing\.current\)/);
  assert.match(touchComposer, /onSubmit\(draft, running \? "steer" : "queue"\)/);
  assert.match(touchComposer, /\{running \? \([\s\S]*?>Stop<\/button>[\s\S]*?\) : \([\s\S]*?>Send<\/button>[\s\S]*?\)\}/);
  assert.equal(matches(touchComposer, /className="agent-touch-actions"/g), 1);
  assert.doesNotMatch(touchComposer, />Steer<|>Queued</);
  assert.equal(matches(touchComposer, /enter send · shift\+enter newline/g), 1);
  assert.match(touchComposer, />│<\/span>/);
  assert.doesNotMatch(touchComposer, /\x1b\[200~|bracketed-paste/i);
  assert.match(terminal, /inputMode: touchInput \? "composer" : "xterm"/);
  assert.match(terminal, /active\.current\?\.setInputMode\(touchInput \? "composer" : "xterm"\)/);
  assert.match(demoTerminal, /if \(inputMode === "composer"\) return `\$\{CLEAR_SCREEN\}\$\{HIDE_CURSOR\}\$\{content\}`/);
  assert.match(demoTerminal, /inputMode !== "xterm"/);

  const touchCss = terminalCss.indexOf("@media (pointer: coarse), (any-pointer: coarse)");
  assert.notEqual(touchCss, -1);
  assert.match(ruleBlock(terminalCss, ".agent-touch-composer textarea {", touchCss), /font:\s*400 16px/);
  assert.match(ruleBlock(terminalCss, ".agent-touch-actions button {", touchCss), /min-height:\s*44px/);
  const composer = ruleBlock(terminalCss, ".agent-touch-composer {", touchCss);
  assert.match(composer, /position:\s*relative/);
  assert.match(composer, /min-height:\s*var\(--terminal-composer-min-height\)/);
  assert.match(terminalCss, /--terminal-composer-min-height:\s*calc\(60px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(composer, /env\(safe-area-inset-left\)/);
  assert.match(composer, /env\(safe-area-inset-right\)/);
  assert.match(terminal, /active\.current\.submit\(input, \{ intent, submittedAt \}\)/);
  assert.match(terminal, /active\.current\?\.cancel\(\)/);
});

test("the phone transcript owns the remaining workspace and native vertical gestures", () => {
  const compact = terminalCss.indexOf(
    `@media ${compactQuery}`,
    terminalCss.indexOf(".conversation-list"),
  );
  const compactCss = terminalCss.slice(compact);
  const workspace = ruleBlock(compactCss, ".conversation-workspace {");
  const main = ruleBlock(compactCss, ".conversation-main {");
  const viewport = ruleBlock(terminalCss, ".agent-xterm .xterm-viewport {");
  const scrollable = ruleBlock(terminalCss, ".agent-xterm .xterm-scrollable-element {");
  const compactHome = homeCss.slice(homeCss.lastIndexOf(`@media ${compactQuery}`));

  assert.match(workspace, /grid-template-rows:\s*44px minmax\(0, 1fr\)/);
  assert.match(main, /grid-row:\s*2/);
  assert.match(main, /min-height:\s*0/);
  assert.match(viewport, /touch-action:\s*pan-y/);
  assert.match(viewport, /overscroll-behavior-y:\s*contain/);
  assert.match(scrollable, /touch-action:\s*none/);
  assert.match(terminalSurface, /bindTouchTerminalScroll\(element\.current, terminal\)/);
  assert.match(terminalSurface, /terminal\.scrollLines\(lines\)/);
  assert.match(ruleBlock(compactHome, ".home-page.is-agent .home-demo {"), /minmax\(0, 1fr\)/);
  assert.match(ruleBlock(compactHome, ".home-page.is-agent .home-demo-head {"), /display:\s*none/);
});

test("touch terminal geometry follows the visual viewport without weakening hidden focus", () => {
  assert.match(terminalSurface, /const viewport = window\.visualViewport/);
  assert.match(terminalSurface, /viewport\?\.addEventListener\("resize", measure\)/);
  assert.match(terminalSurface, /viewport\?\.addEventListener\("scroll", measure\)/);
  assert.match(terminalSurface, /window\.addEventListener\("orientationchange", measure\)/);
  assert.match(terminalSurface, /root\.style\.height = `\$\{available\}px`/);
  assert.match(terminalSurface, /composer\?\.getBoundingClientRect\(\)\.height/);
  assert.match(terminalSurface, /getComputedStyle\(composer\)\.paddingBottom/);
  assert.match(terminalSurface, /minimum: composerMinimum/);
  assert.match(terminalSurface, /shell\.style\.height = `\$\{Math\.min\(naturalHeight, shellAvailable\)\}px`/);
  assert.match(terminalCss, /\.nanocodex-demo\.is-full \.agent-terminal-shell:focus-within/);
  const touchCss = terminalCss.indexOf("@media (pointer: coarse), (any-pointer: coarse)");
  assert.match(ruleBlock(terminalCss, ".agent-terminal-shell {", touchCss), /grid-template-rows:\s*minmax\(0, 1fr\) auto/);
  assert.match(
    ruleBlock(terminalCss, ".nanocodex-demo.is-preview .agent-terminal-shell:focus-within,", touchCss),
    /min-height:\s*120px/,
  );
  assert.match(terminalSurface, /host\.parentElement\?\.contains\(window\.document\.activeElement\)/);
  assert.match(terminalSurface, /textarea\.readOnly = touchInput/);
  assert.match(terminalSurface, /textarea\.tabIndex = touchInput \? -1 : 0/);
});

test("terminal input survives the xterm/agent startup race", () => {
  assert.match(terminalSurface, /const terminalHost = bufferedXtermAdapter\(terminal\)/);
  assert.match(terminalSurface, /latest\.current\.onReady\(terminalHost\.host\)/);
  assert.match(terminalSurface, /terminalHost\.dispose\(\)/);
});

  test("the website owns its terminal presentation directly over the SDK", () => {
  assert.match(terminal, /createAgentTerminal\(\{/);
  assert.match(terminal, /createAgentTerminal\(\{[\s\S]*?agent,[\s\S]*?terminal: terminalHost/);
  assert.match(terminal, /setTerminalRunning\(activePromptIds\.current\.size > 0\)/);
  assert.match(demoTerminal, /agent\.turn\.prompt\(\{ input: prompt \}\)/);
  assert.doesNotMatch(terminal, /new Worker|postMessage/);
});

test("the artifact runtime remains independently scrollable", () => {
  assert.ok(artifactRuntime.includes('document.documentElement.classList.add("artifact-runtime-page")'));
  assert.match(indexCss, /\.artifact-runtime-page body \{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-y:\s*auto;[\s\S]*?\}/);
});

test("phone auth controls and other application targets meet mobile baselines", () => {
  assert.match(ruleBlock(terminalCss, ".agent-session-actions button,", terminalCss.indexOf(`@media ${compactQuery}`)), /min-height:\s*44px/);
  assert.match(ruleBlock(terminalCss, ".conversation-list-error button {"), /min-height:\s*44px/);

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

  assert.match(ruleBlock(indexCss, ".search-field button {", phone), /width:\s*44px[\s\S]*?height:\s*44px/);
  assert.match(ruleBlock(indexCss, ".search-result {", phone), /min-height:\s*44px/);

  const coarseTerminal = terminalCss.indexOf(`@media ${coarseQuery}`);
  assert.match(ruleBlock(terminalCss, ".agent-oauth-code a,", coarseTerminal), /min-height:\s*var\(--coarse-target-size\)/);
  assert.match(ruleBlock(terminalCss, ".artifact-dock-header > select {", coarseTerminal), /height:\s*var\(--coarse-target-size\)/);
  assert.match(ruleBlock(terminalCss, ".artifact-preview-button {", coarseTerminal), /min-height:\s*var\(--coarse-target-size\)/);
  const coarseApplication = indexCss.indexOf(`@media ${coarseQuery}`);
  assert.match(
    ruleBlock(indexCss, ".requests-empty .button,", coarseApplication),
    /min-height:\s*var\(--coarse-target-size\)/,
  );
  assert.match(
    ruleBlock(indexCss, ".commit-stream-tail-error button,", coarseApplication),
    /min-height:\s*var\(--coarse-target-size\)/,
  );
});

test("expanded artifact docks stay inside every safe-area edge", () => {
  const fullscreen = ruleBlock(terminalCss, ".nanocodex-demo.is-full .artifact-dock.is-fullscreen {", 0);
  const compact = terminalCss.indexOf(`@media ${compactQuery}`);
  const mobile = ruleBlock(
    terminalCss,
    ".nanocodex-demo.is-full .artifact-dock:not(.is-collapsed) {",
    compact,
  );

  for (const inset of ["top", "right", "bottom", "left"]) {
    assert.match(fullscreen, new RegExp(`max\\(18px, env\\(safe-area-inset-${inset}\\)\\)`));
    assert.match(mobile, new RegExp(`max\\(10px, env\\(safe-area-inset-${inset}\\)\\)`));
  }
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

test("the terminal chrome delegates account and model connection controls to the account menu", () => {
  assert.doesNotMatch(modelSession, /Connected to your ChatGPT subscription/);
  assert.doesNotMatch(modelSession, /The agent runs in your browser/);
  assert.match(modelSession, /aria-live="polite"/);
  assert.match(modelSession, /Connect ChatGPT or an OpenAI API key from the account menu/);
  assert.match(modelSession, /Sign in with a passkey from the account menu/);
  assert.doesNotMatch(`${terminal}\n${modelSession}`, /Tempo|MPP|payment details|onSelectTransport/);
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
