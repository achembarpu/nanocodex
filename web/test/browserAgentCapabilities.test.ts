import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { browserAgentCapabilityError } from "../src/browserAgentCapabilities.ts";

const currentSafari = () => ({
  Worker: class Worker {},
  WebAssembly: { instantiate() {} },
  WebSocket: class WebSocket {},
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  isSecureContext: true,
  navigator: {
    locks: { request() {} },
    storage: { getDirectory() {} },
  },
});

test("current stable Safari capabilities admit the complete browser agent without JSPI", () => {
  assert.equal(browserAgentCapabilityError(currentSafari() as never), undefined);
  const gate = source("../src/browserAgentCapabilities.ts");
  assert.doesNotMatch(gate, /Suspending|promising|JSPI|jspi/);
  assert.doesNotMatch(gate, /userAgent|Safari\//);
});

test("only capabilities used by the Worker, transport, thread, and workspace are gated", () => {
  const cases = [
    ["Worker", "Web Workers"],
    ["WebAssembly", "WebAssembly"],
    ["WebSocket", "WebSockets"],
  ] as const;
  for (const [capability, message] of cases) {
    const scope = currentSafari() as Record<string, unknown>;
    scope[capability] = undefined;
    assert.match(browserAgentCapabilityError(scope as never) ?? "", new RegExp(message));
  }

  const noOpfs = currentSafari();
  noOpfs.navigator.storage.getDirectory = undefined as never;
  assert.match(browserAgentCapabilityError(noOpfs as never) ?? "", /OPFS/);

  const noLocks = currentSafari();
  noLocks.navigator.locks.request = undefined as never;
  assert.match(browserAgentCapabilityError(noLocks as never) ?? "", /Web Locks/);

  const insecure = currentSafari();
  insecure.isSecureContext = false;
  assert.match(browserAgentCapabilityError(insecure as never) ?? "", /secure HTTPS/);
});

test("the terminal fails before thread or Worker creation and exposes the capability error", () => {
  const terminal = source("../src/AgentTerminal.tsx");
  const session = source("../src/chatGptSession.tsx");
  assert.match(terminal, /if \(capabilityError\) \{[\s\S]*?role="alert">\{capabilityError\}/);
  assert.match(terminal, /const thread = useMemo\(\(\) => getBrowserThread\(\), \[\]\)/);
  assert.match(terminal, /<NanocodexProvider config=\{agentConfig\}>[\s\S]*?<AgentTerminalDemo/);
  assert.match(terminal, /role="alert">\{capabilityError\}/);
  assert.match(session, /if \(capabilityError\) return "browser unsupported"/);
});

test("coarse-pointer Safari keeps native IME composition separate from send", () => {
  const terminal = source("../src/AgentTerminal.tsx");
  const surface = source("../src/agentTerminalSurface.tsx");
  assert.match(surface, /<textarea[\s\S]*?enterKeyHint="send"/);
  assert.match(surface, /onCompositionStart=\{\(\) => \{ composing\.current = true; \}\}/);
  assert.match(surface, /onCompositionEnd=\{\(\) => \{ composing\.current = false; \}\}/);
  assert.match(surface, /isTerminalSubmitKeyEvent\(event\.nativeEvent, composing\.current\)/);
  assert.match(terminal, /active\.current\.submit\(input, \{ intent \}\)/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
