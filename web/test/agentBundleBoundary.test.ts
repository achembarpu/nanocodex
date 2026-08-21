import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const application = source("../src/NanocodexApp.tsx");
const entry = source("../src/main.tsx");
const routeLoaders = source("../src/routeLoaders.ts");
const experience = source("../src/AgentExperience.tsx");
const evals = source("../src/Evals.tsx");
const terminal = source("../src/AgentTerminal.tsx");
const terminalCss = source("../src/AgentTerminal.css");

test("home routes preload only the lightweight credential experience", () => {
  assert.match(entry, /preloadDirectSurface/);
  assert.doesNotMatch(entry, /import\("\.\/AgentTerminal"\)/);
  assert.match(routeLoaders, /import\("\.\/AgentExperience"\)/);
  assert.match(application, /loadAgentExperience/);
  assert.doesNotMatch(application, /import\("\.\/AgentTerminal"\)/);
  assert.doesNotMatch(routeLoaders, /import\("\.\/AgentTerminal"\)/);

  assert.doesNotMatch(
    experience,
    /from "nanocodex-react"|from "\.\/agentTerminalSurface"|from "\.\/ArtifactDock"|from "\.\/browserMcp"/,
  );
  assert.match(terminal, /from "nanocodex-react"/);
  assert.match(terminal, /from "\.\/agentTerminalSurface"/);
  assert.match(terminal, /from "\.\/ArtifactDock"/);
  assert.match(terminal, /from "\.\/browserMcp"/);
});

test("evaluation query state stays behind the Evals route", () => {
  assert.doesNotMatch(`${entry}\n${application}\n${routeLoaders}`, /from "@tanstack\/react-query"/);
  assert.match(evals, /QueryClientProvider client=\{queryClient\}/);
  assert.match(evals, /export async function preloadEvalOverview/);
  assert.match(routeLoaders, /surface === "evals"[\s\S]*?preloadEvalOverview\(\)/);
});

test("authenticated credential readiness is the sole terminal import gate", () => {
  assert.equal(matches(experience, /import\("\.\/AgentTerminal"\)/g), 1);
  assert.match(
    experience,
    /const hasCredential = isAuthenticatedCredential\(credentialSource\)/,
  );
  const credentialEffect = section(
    experience,
    "  useEffect(() => {\n    if (!hasCredential || capabilityError)",
    "\n\n  const agentStatus:",
  );
  assert.match(
    credentialEffect,
    /if \(!hasCredential \|\| capabilityError\) \{[\s\S]*?return;[\s\S]*?loadAgentTerminal\(\)/,
  );
  assert.match(
    experience,
    /\{hasCredential && !capabilityError && AgentTerminal \? \([\s\S]*?<AgentTerminal/,
  );
  assert.match(experience, /source === "subscription" \|\| source === "user"/);
  assert.match(terminal, /useAgent\(\{ enabled: true, threadId: thread\?\.id \}\)/);

  assert.match(experience, /export function preloadAgentTerminal\(\)/);
  assert.match(
    routeLoaders,
    /const experience = loadAgentExperience\(\)[\s\S]*?deploymentHealth\.read\(\)\.then[\s\S]*?health\.credentialSource !== null[\s\S]*?preloadAgentTerminal\(\)/,
  );
  assert.match(routeLoaders, /await Promise\.all\(\[loadHomeFrame\(\), experience\]\)/);
});

test("signed-out and runtime-import states retain complete terminal geometry without loading UI", () => {
  const reserve = section(experience, "function ReservedTerminal", "function isAuthenticatedCredential");
  assert.match(reserve, /className="agent-terminal-shell"/);
  assert.match(reserve, /mode === "full"[\s\S]*?className="agent-terminal-workspace"/);
  assert.match(terminalCss, /\.agent-terminal-shell \{[\s\S]*?height:\s*clamp\(300px, 36svh, 380px\)/);
  assert.match(
    terminalCss,
    /\.nanocodex-demo\.is-full \.agent-terminal-workspace > \.agent-terminal-shell \{[\s\S]*?height:\s*100%/,
  );
  assert.doesNotMatch(experience, /<Suspense|fallback=|loading|spinner|skeleton/i);

  assert.match(experience, /setAgentTerminalError\(errorMessage\(cause\)\)/);
  assert.match(
    experience,
    /if \(agentTerminalError !== undefined\) \{[\s\S]*?setLoadAttempt\(\(attempt\) => attempt \+ 1\)/,
  );
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

function matches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}
