import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { browserMcpConfiguration } from "../src/browserMcp.ts";

const terminal = source("../src/AgentTerminal.tsx");
const dock = source("../src/ArtifactDock.tsx");
const terminalCss = source("../src/AgentTerminal.css");
const experience = source("../src/AgentExperience.tsx");
const viteConfig = source("../vite.config.ts");

test("one app-lifetime Config supplies clone-safe MCP servers to the retained Agent", () => {
  const declaration = section(terminal, "const agentConfig = createConfig", "/** Authenticated website policy");
  assert.equal(matches(terminal, /createConfig\(/g), 1);
  assert.match(declaration, /createConfig\(\{[\s\S]*?agent: \{[\s\S]*?mcp: browserMcpConfiguration\(location\.origin\)/);
  assert.match(
    terminal,
    /useNanocodex\(\{ config: agentConfig, threadId \}\)/,
  );
  assert.doesNotMatch(terminal, /prepareAgentRuntime|NanocodexProvider/);

  const configuration = browserMcpConfiguration("https://agent.test/path");
  assert.deepEqual(structuredClone(configuration), configuration);
  assert.ok(Object.values(configuration).every((server) =>
    typeof server.url === "string"
    && Array.isArray(server.enabledTools)
    && Object.values(server.headers).every((value) => typeof value === "string")));
});

test("the full Agent experience alone mounts a collapsed, counted artifact dock", () => {
  assert.match(terminal, /mode === "full" \? \([\s\S]*?className="agent-terminal-workspace"[\s\S]*?<ArtifactDock[\s\S]*?\) : terminal/);
  assert.equal(matches(terminal, /<ArtifactDock\b/g), 1);
  assert.match(dock, /const \[collapsed, setCollapsed\] = useState\(true\)/);
  assert.match(dock, /aria-expanded=\{false\}/);
  assert.match(dock, /aria-label=\{`Open artifacts, \$\{artifactCount\}`\}/);
  assert.match(dock, /<span aria-hidden="true">\{artifacts\.length\}<\/span>/);
  assert.match(dock, /const expand = useCallback\(\(\) => \{[\s\S]*?setCollapsed\(false\)/);
  assert.match(dock, /onClick=\{expand\}/);
  assert.match(dock, /label="Collapse artifacts"[\s\S]*?onClick=\{collapse\}/);
  assert.match(dock, /subscribeThreadWorkspaceChanges\([\s\S]*?getBrowserThread\(\)\.id,[\s\S]*?refresh\(store\)/);

  assert.match(ruleBlock(terminalCss, ".nanocodex-demo.is-full .agent-terminal-workspace > .agent-terminal-shell {"), /height:\s*100%/);
  assert.match(ruleBlock(terminalCss, ".nanocodex-demo.is-full .artifact-dock {"), /position:\s*absolute/);
  const toggle = ruleBlock(terminalCss, ".nanocodex-demo.is-full .artifact-dock.is-collapsed > button {");
  assert.match(toggle, /min-width:\s*44px/);
  assert.match(toggle, /min-height:\s*44px/);
});

test("an artifact action queues exactly one contextual follow-on on the retained terminal", () => {
  const ask = section(dock, "const ask =", "const createExample =");
  assert.equal(matches(ask, /onPrompt\(/g), 1);
  assert.match(ask, /onPrompt\(selected, prompt, store\.path\(selected\.id\)\)/);

  const submit = section(terminal, "const submitArtifactPrompt =", "const terminal =");
  assert.match(submit, /const retainedTerminal = active\.current/);
  assert.equal(matches(submit, /retainedTerminal\.submit\(/g), 1);
  assert.match(submit, /artifactFollowOnPrompt\(artifact, path, prompt\)/);
  assert.match(submit, /\{ intent: "queue", submittedAt: performance\.now\(\) \}/);
  const contextualPrompt = section(terminal, "function artifactFollowOnPrompt", "function markAgentTiming");
  assert.match(contextualPrompt, /JSON\.stringify\(artifact\.id\)/);
  assert.match(contextualPrompt, /JSON\.stringify\(path\)/);
  assert.match(contextualPrompt, /prompt\.trim\(\)/);
  assert.doesNotMatch(`${terminal}\n${dock}`, /NanocodexTui|Artifact action queued|loading|spinner|skeleton/i);
});

test("credential-gated terminal uses the normal static Vite graph", () => {
  assert.match(viteConfig, /optimizeDeps:\s*\{\s*exclude: \["nanocodex", "nanocodex-react"\]/);
  assert.doesNotMatch(viteConfig, /optimizeDeps:[\s\S]*?include:/);
  assert.match(
    experience,
    /import \{ AgentTerminal, ManagedAgentTerminal \} from "\.\/AgentTerminal"/,
  );
  assert.doesNotMatch(experience, /import\(|\blazy\b|loadAgentTerminal|preloadAgentTerminal|prepareAgentRuntime/);
});

test("managed conversation selection is invalidated when account ownership changes", () => {
  assert.match(
    experience,
    /useEffect\(\(\) => \{\s*setManagedConversations\(\[\]\);\s*setManagedConversationId\(undefined\);\s*setRuntimeState\(undefined\);\s*\}, \[account\.account\?\.id\]\)/,
  );
  assert.match(experience, /managedSelectionKey\(accountId\)/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function section(value: string, start: string, end: string): string {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return value.slice(from, to);
}

function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `missing ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(start, close + 1);
}

function matches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}
