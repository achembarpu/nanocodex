import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminal = source("../src/AgentTerminal.tsx");
const demoTerminal = source("../src/demoTerminal.ts");
const experience = source("../src/AgentExperience.tsx");
const session = source("../src/modelSession.tsx");
const accountSession = source("../src/AccountSession.tsx");
const health = source("../src/deploymentHealth.ts");
const localCredential = source("../src/localDevelopmentCredential.ts");
const surface = source("../src/agentTerminalSurface.tsx");
const terminalCss = source("../src/AgentTerminal.css");

test("account authentication naturally selects the private broker", () => {
  assert.match(session, /useAccountSession\(\)\.account/);
  assert.match(health, /payload\.credential_source === "brokered"/);
  assert.match(session, /fresh\s*\? deploymentHealth\.refresh\(\)\s*:\s*deploymentHealth\.read\(\)/);
  assert.match(session, /previousAccountId !== undefined && previousAccountId !== account\.id/);
  assert.match(session, /try \{ await readStatus\(true\); \} finally/);
  assert.match(session, /window\.addEventListener\("focus", refreshAfterInactivity\)/);
  assert.match(session, /if \(!event\.persisted\) return/);
  assert.match(session, /nanocodex:model-credential-changed/);
});

test("AccountSession solely owns localhost credential import and invalidation", () => {
  assert.match(accountSession, /localDevelopmentCredential\.ensure\(userId\)/);
  assert.match(accountSession, /if \(localClaimAccountId\.current === userId && claimed\)/);
  assert.match(accountSession, /if \(localClaimAccountId\.current === userId\) return/);
  assert.match(accountSession, /deploymentHealth\.invalidate\(\)/);
  assert.doesNotMatch(session, /localDevelopmentCredential|deploymentHealth\.invalidate\(\)/);
  assert.match(localCredential, /LOOPBACK_HOSTS\.has\(hostname\)/);
  assert.match(localCredential, /current\?\.userId === userId/);
  assert.match(localCredential, /Local development credential claim failed/);
  assert.doesNotMatch(localCredential, /nanocodex\.gakonst|workers\.dev/);
});

test("credential presence is distinct from agent readiness and failures are manually actionable", () => {
  assert.match(session, /const ready = agentStatus === "ready"/);
  assert.match(session, /agentStatus === "error" && hasCredential/);
  assert.match(session, />retry agent<\/button>/);
  assert.match(session, />retry connection<\/button>/);
  assert.match(session, /agentStartFailure\(agentError\)/);
  assert.match(terminal, /const retryAgent = useCallback\(\(\) => \{[\s\S]*?refetch\(\)/);
  assert.doesNotMatch(`${terminal}\n${session}`, /automaticRetry|workerRecoveryAttempts/);
  assert.doesNotMatch(`${terminal}\n${session}`, /Connect to start\./);
});

test("signed-out browsers wait for the account-owned model connection", () => {
  assert.match(experience, /credentialSource === "brokered"/);
  assert.match(experience, /hasCredential && !activeCapabilityError && \(runtime === "local" \|\| managedConversationId\)/);
  assert.match(session, /Sign in with a passkey to start the browser agent/);
  assert.doesNotMatch(`${experience}\n${terminal}\n${session}`, /guest|sponsor|"deployment"|backend-anon|anonymous (?:OpenAI|ChatGPT|Codex)/i);
});

test("starting and failure states repaint the terminal while the native mobile composer remains intact", () => {
  assert.match(surface, /current\.status !== "ready" && current\.status !== "starting"/);
  assert.match(surface, /status === "ready" \|\| status === "starting" \|\| !instance\.current/);
  assert.match(surface, /onCompositionStart/);
  assert.match(surface, /isTerminalSubmitKeyEvent\(event\.nativeEvent, composing\.current\)/);
  assert.doesNotMatch(surface, /aria-label="Message Nanocodex"[\s\S]{0,120}disabled=\{!ready\}/);
  assert.match(terminal, /setPendingTouchSubmission\(\{ input, intent, submittedAt \}\)/);
  assert.match(terminal, /agentStatus !== "ready" \|\| !pendingTouchSubmission \|\| !active\.current/);
  assert.match(terminalCss, /\.agent-touch-composer textarea \{[\s\S]*?font:\s*400 16px\/22px/);
});

test("the React package owns browser Agent startup through useNanocodex", () => {
  assert.match(terminal, /import \{[\s\S]*?createConfig,[\s\S]*?useNanocodex,[\s\S]*?\} from "nanocodex-react"/);
  assert.match(terminal, /data: agent,[\s\S]*?\} = useNanocodex\(\{ config: agentConfig, threadId \}\)/);
  assert.match(terminal, /createAgentTerminal\(\{[\s\S]*?agent,[\s\S]*?terminal: terminalHost/);
  assert.doesNotMatch(terminal, /useAgentEvents|includeAllSessions/);
  assert.doesNotMatch(terminal, /NanocodexProvider|agent\.agent|createDemoAgent|prewarmDemoAgent|prepareAgent/);
});

test("TTFT spans user submission through exact root first output", () => {
  assert.match(terminal, /const submittedAt = performance\.now\(\)/);
  assert.match(terminal, /submittedAt: pendingTouchSubmission\.submittedAt/);
  assert.match(terminal, /prompt\.submit_to_first_token/);
  assert.match(terminal, /prompt\.run_started_to_first_token/);
  assert.doesNotMatch(terminal, /prompt\.first_token/);
  assert.match(demoTerminal, /event\.request_id !== agent\.sessionId/);
  assert.match(demoTerminal, /event\.type === "run\.started"/);
  assert.match(demoTerminal, /eventSeq: event\.seq/);
});

test("terminal adapter replacement ignores stale readiness and disposes its local attachment", () => {
  assert.match(terminal, /void attached\.ready\.then\(\(\) => \{[\s\S]*?if \(cancelled\) return/);
  assert.match(terminal, /return \(\) => \{[\s\S]*?cancelled = true;[\s\S]*?attached\.dispose\(\)/);
});

test("touch terminals keep xterm output readable without hiding a focusable textarea", () => {
  assert.match(surface, /screenReaderMode:\s*touchInput/);
  assert.match(surface, /terminal\.options\.screenReaderMode = touchInput/);
  assert.match(surface, /textarea\.removeAttribute\("aria-hidden"\)/);
  assert.doesNotMatch(surface, /textarea\.setAttribute\("aria-hidden"/);
});

test("app-local modules own account model policy and xterm presentation", () => {
  assert.match(experience, /from "\.\/modelSession"/);
  assert.match(terminal, /from "\.\/agentTerminalSurface"/);
  assert.doesNotMatch(`${experience}\n${terminal}`, /new Xterm|\/api\/auth\/chatgpt|deployment_sha|pageshow/);
  assert.match(session, /function useModelSession/);
  assert.match(surface, /export function XtermSurface/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
