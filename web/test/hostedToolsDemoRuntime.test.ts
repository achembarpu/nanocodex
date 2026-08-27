import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentClient, AttachmentTarget } from "nanocodex/tools";
import {
  DETACHED_REFUSAL_MARKER,
  detachHostedToolsCatalog,
  proveDetachedToolRefusal,
  publishHostedToolsCatalog,
  replaceAndFenceHostedToolsCatalog,
  runAttachedEcho,
  type HostedToolExecution,
  type HostedToolsAgent,
  type HostedToolsAttachment,
  type HostedToolsRuntime,
} from "../src/hostedToolsDemoRuntime.ts";

test("catalog publication uses the managed agent target and waits for routing readiness", async () => {
  const calls: string[] = [];
  const target = "wss://nanocodex.test/v1/agents/agent-1/tool-host";
  const client = attachmentClient(true);
  const tools = attachmentRuntime(target, client, calls);
  const published = await publishHostedToolsCatalog(tools, managedAgent(target));

  assert.deepEqual(calls, ["attach", "connect"]);
  assert.equal(published.client, client);
  assert.equal(published.client.connected, true);
});

test("an attached echo proof requires exactly one matching browser execution", async () => {
  const executions: HostedToolExecution[] = [];
  let prompt = "";
  const agent = managedAgent("wss://nanocodex.test/tool-host", async (input) => {
    prompt = input;
    executions.push({
      callId: "call-1",
      generation: 1,
      message: "hello browser",
      sessionId: "session-1",
    });
    return "The browser returned hello browser.";
  });

  const result = await runAttachedEcho(agent, "hello browser", () => executions);

  assert.match(prompt, /browser_echo exactly once/);
  assert.match(prompt, /"hello browser"/);
  assert.equal(result.execution.callId, "call-1");
  assert.equal(result.finalMessage, "The browser returned hello browser.");
});

test("detached refusal passes only when the managed turn leaves the browser untouched", async () => {
  const executions: HostedToolExecution[] = [];
  let prompt = "";
  const agent = managedAgent("wss://nanocodex.test/tool-host", async (input) => {
    prompt = input;
    return DETACHED_REFUSAL_MARKER;
  });

  const reply = await proveDetachedToolRefusal(agent, () => executions);

  assert.match(prompt, /do not invent a result/i);
  assert.equal(reply, DETACHED_REFUSAL_MARKER);
  assert.deepEqual(executions, []);
});

test("graceful detach joins both connector drain and client closure", async () => {
  const calls: string[] = [];
  const attachment = attachmentFixture(calls);

  await detachHostedToolsCatalog(attachment);

  assert.deepEqual(calls, ["connector.close", "client.closed"]);
});

test("a successor becomes ready before the previous attachment must be fenced", async () => {
  const calls: string[] = [];
  let fence!: () => void;
  const fenced = new Promise<void>((resolve) => { fence = resolve; });
  const current = attachmentFixture(calls, fenced);
  const target = "wss://nanocodex.test/v1/agents/agent-1/tool-host";
  const successor = attachmentClient(true);
  const tools = attachmentRuntime(target, successor, calls);

  const replacing = replaceAndFenceHostedToolsCatalog(
    tools,
    managedAgent(target),
    current,
    1_000,
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["attach", "connect", "client.closed"]);
  fence();

  const replaced = await replacing;
  assert.equal(replaced.client, successor);
  assert.equal(replaced.client.connected, true);
});

function managedAgent(
  target: AttachmentTarget,
  result: (input: string) => Promise<string> = async () => "unused",
): HostedToolsAgent {
  return {
    id: "agent-1",
    toolsTarget: () => target,
    turn: {
      prompt: ({ input }) => ({
        result: async () => ({ finalMessage: await result(input) }),
      }),
    },
  };
}

function attachmentRuntime(
  expectedTarget: AttachmentTarget,
  client: AttachmentClient,
  calls: string[],
): HostedToolsRuntime {
  return {
    attach(target) {
      assert.equal(target, expectedTarget);
      calls.push("attach");
      return {
        async connect() { calls.push("connect"); return client; },
        async closed() {},
        async close() { calls.push("connector.close"); },
      };
    },
  };
}

function attachmentClient(
  connected: boolean,
  closed: Promise<void> = Promise.resolve(),
  calls?: string[],
): AttachmentClient {
  return {
    connected,
    async close() { calls?.push("client.close"); },
    async closed() { calls?.push("client.closed"); await closed; },
  };
}

function attachmentFixture(calls: string[], closed = Promise.resolve()): HostedToolsAttachment {
  return {
    client: attachmentClient(true, closed, calls),
    connector: {
      async connect() { return attachmentClient(true); },
      async closed() {},
      async close() { calls.push("connector.close"); },
    },
  };
}
