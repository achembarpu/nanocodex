import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminal = source("../src/AgentTerminal.tsx");
const terminalCss = source("../src/AgentTerminal.css");

test("browser authentication automatically selects the supported agent credential", () => {
  assert.match(terminal, /next\.state === "authenticated"[\s\S]*?onSourceChange\("subscription"\)/);
  assert.match(terminal, /credential_source === "subscription"/);
  assert.match(terminal, /window\.addEventListener\("focus", refreshWhenVisible\)/);
  assert.match(terminal, /document\.addEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(terminal, /This terminal will start automatically/);
});

test("sign-out invalidates refreshes from before and during the credential mutation", () => {
  const signOut = terminal.slice(
    terminal.indexOf("const signOut = async"),
    terminal.indexOf("const ready =", terminal.indexOf("const signOut = async")),
  );
  assert.equal(matches(signOut, /\+\+authGeneration\.current|authGeneration\.current \+= 1/g), 2);
  assert.match(signOut, /method: "DELETE"[\s\S]*?publishStatus\(\{ state: "signed_out" \}\)[\s\S]*?await refreshStatus\(\)/);
});

test("credential presence is distinct from agent readiness and exhausted retries are actionable", () => {
  assert.match(terminal, /const ready = agentStatus === "ready"/);
  assert.match(terminal, /automaticRetryPending/);
  assert.match(terminal, />retry agent<\/button>/);
  assert.match(terminal, />retry session<\/button>/);
  assert.match(terminal, /agentStartFailure\(agentError, source\)/);
  assert.doesNotMatch(terminal, /Connect to start\./);
});

test("signed-out browsers wait for explicit ChatGPT authentication", () => {
  assert.match(terminal, /credentialSource === "user"[\s\S]*?startCommand\("openai"/);
  assert.match(terminal, /Sign in with ChatGPT to start the browser agent/);
  assert.doesNotMatch(terminal, /guest|sponsor|"deployment"|backend-anon|anonymous (?:OpenAI|ChatGPT|Codex)/i);
});

test("starting and failure states repaint the terminal while the native mobile composer remains intact", () => {
  assert.match(terminal, /if \(current\.status !== "ready"\)/);
  assert.match(terminal, /if \(status === "ready" \|\| !instance\.current\) return/);
  assert.match(terminal, /onCompositionStart/);
  assert.match(terminal, /isTerminalSubmitKeyEvent\(event\.nativeEvent, composing\.current\)/);
  assert.match(terminalCss, /\.agent-touch-composer textarea \{[\s\S]*?font:\s*400 16px\/22px/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function matches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}
