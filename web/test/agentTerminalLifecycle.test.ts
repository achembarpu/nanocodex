import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminal = [
  source("../src/AgentTerminal.tsx"),
  source("../../js/terminal/src/AgentTerminalView.tsx"),
  source("../../js/terminal/src/TerminalTranscriptSurface.tsx"),
].join("\n");
const experience = source("../src/AgentExperience.tsx");
const session = source("../src/modelSession.tsx");
const accountSession = source("../src/AccountSession.tsx");
const health = source("../src/deploymentHealth.ts");
const localCredential = source("../src/localDevelopmentCredential.ts");
const terminalCss = [
  source("../src/AgentTerminal.css"),
  source("../../js/terminal/styles.css"),
].join("\n");
const composer = source("../../js/terminal/src/TerminalComposer.tsx");

test("account authentication naturally selects the private broker", () => {
  assert.match(session, /const accountSession = useAccountSession\(\)/);
  assert.match(session, /if \(accountSession\.status !== "ready"\) \{\s*generation\.current\+\+;\s*return;/);
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
  assert.match(accountSession, /if \(localClaim\.current\?\.userId === userId\) return localClaim\.current\.promise/);
  assert.match(accountSession, /await claimLocalCredential\(nextUser\.id\);\s*if \(requestId\.current !== currentRequest\) return;/);
  assert.match(accountSession, /deploymentHealth\.invalidate\(\)/);
  assert.doesNotMatch(session, /localDevelopmentCredential|deploymentHealth\.invalidate\(\)/);
  assert.match(localCredential, /LOCAL_DEVELOPMENT_HOSTS\.has\(hostname\)/);
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

test("signed-out runtimes wait for the account-owned model connection", () => {
  assert.match(experience, /credentialSource === "brokered"/);
  assert.match(experience, /landing[\s\S]*?hasCredential && !activeCapabilityError && deploymentCurrent/);
  assert.match(experience, /hasCredential && managedConversationId[\s\S]*?<ManagedAgentTerminal/);
  assert.match(session, /Sign in with a passkey to start the \$\{agent\}/);
  assert.match(session, /runtime === "managed" \? "managed agent" : "browser agent"/);
  assert.match(experience, /runtime: landing \? "browser" : "managed"/);
  assert.doesNotMatch(`${experience}\n${terminal}\n${session}`, /guest|sponsor|"deployment"|backend-anon|anonymous (?:OpenAI|ChatGPT|Codex)/i);
});

test("starting and failure states repaint the terminal while the native mobile composer remains intact", () => {
  assert.match(terminal, /status !== "ready" && inactiveMessage/);
  assert.match(terminal, /role=\{status === "error" \? "alert" : "status"\}/);
  assert.match(composer, /onCompositionStart/);
  assert.match(composer, /isSubmitKeyEvent\(event\.nativeEvent, composing\.current\)/);
  assert.doesNotMatch(composer, /aria-label="Message Nanocodex"[\s\S]{0,120}disabled=\{!ready\}/);
  assert.match(terminal, /setPendingTouchSubmission\(\{ input, submittedAt \}\)/);
  assert.match(terminal, /agentStatus !== "ready" \|\| !pendingTouchSubmission/);
  assert.match(terminalCss, /\.agent-touch-composer textarea \{[\s\S]*?font:\s*400 16px\/22px/);
});

test("the React package owns browser Agent startup and the complete conversation controller", () => {
  assert.match(terminal, /import \{[\s\S]*?createConfig,[\s\S]*?useNanocodex,[\s\S]*?\} from "nanocodex-react"/);
  assert.match(terminal, /data: agent,[\s\S]*?\} = useNanocodex\(\{ config: agentConfig, threadId \}\)/);
  assert.match(terminal, /useAgentController,[\s\S]*?from "nanocodex-react\/agent"/);
  assert.match(terminal, /const controller = useAgentController\(agent, \{[\s\S]*?visible: mode !== "hidden"/);
  assert.doesNotMatch(terminal, /createAgentTerminal|initialTerminalState|applyAgentEvents/);
  assert.doesNotMatch(terminal, /useAgentEvents|includeAllSessions/);
  assert.doesNotMatch(terminal, /NanocodexProvider|agent\.agent|createDemoAgent|prewarmDemoAgent|prepareAgent/);
});

test("TTFT spans user submission through exact root first output", () => {
  assert.match(terminal, /const submittedAt = performance\.now\(\)/);
  assert.match(terminal, /pendingTouchSubmission\.submittedAt/);
  assert.match(terminal, /prompt\.submit_to_first_token/);
  assert.match(terminal, /prompt\.run_started_to_first_token/);
  assert.doesNotMatch(terminal, /prompt\.first_token/);
  assert.match(terminal, /agentEvent\.type === "run\.started"/);
  assert.match(terminal, /eventSeq: agentEvent\.seq/);
});

test("terminal readiness follows the public controller attachment identity", () => {
  assert.match(terminal, /readySessionId === agent\.sessionId/);
  assert.match(terminal, /observedEvent\.type === "controller\.attached"/);
  assert.match(terminal, /setReadySessionId\(\(current\) => current === observedEvent\.sessionId \? undefined : current\)/);
});

test("the DOM transcript and native composer remain the only terminal surfaces", () => {
  assert.match(terminal, /className="agent-dom-transcript"/);
  assert.match(composer, /<textarea/);
  assert.doesNotMatch(terminal, /agent-terminal-brand/);
  assert.doesNotMatch(`${terminal}\n${composer}`, /Xterm|agent-xterm|xterm-helper-textarea/);
});

test("app policy composes the package-owned Markdown presentation", () => {
  assert.match(experience, /from "\.\/modelSession"/);
  assert.match(terminal, /from "streamdown"/);
  assert.match(terminal, /from "nanocodex-terminal"/);
  assert.doesNotMatch(`${experience}\n${terminal}`, /new Xterm|\/api\/auth\/chatgpt|deployment_sha|pageshow/);
  assert.match(session, /function useModelSession/);
  assert.match(terminal, /className="agent-dom-transcript"/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
