import assert from "node:assert/strict";
import { test } from "node:test";

import * as BrowserTransport from "../browser/Transport.mjs";
import * as NodeTransport from "../node/Transport.mjs";
import * as Subagents from "../runtime/subagents.mjs";
import { resolveTools } from "../runtime/tool-configuration.mjs";

test("Responses transports own authentication and connection setup", () => {
  const openAi = NodeTransport.openAi({
    apiKey: "sk-test",
    websocketUrl: "wss://responses.test",
    websocketWarmup: true,
  });
  assert.deepEqual(NodeTransport.resolve(openAi), {
    apiKey: "sk-test",
    apiBaseUrl: undefined,
    websocketUrl: "wss://responses.test",
    websocketWarmup: true,
  });
  assert.equal(Object.isFrozen(openAi), true);

  const createWebSocket = () => ({ socket: {} });
  assert.deepEqual(
    BrowserTransport.resolve(BrowserTransport.hostManaged({ createWebSocket })),
    {
      WebSocketImpl: undefined,
      apiBaseUrl: undefined,
      createWebSocket,
      hostAuth: true,
      hostManagedProtocol: true,
      websocketUrl: undefined,
      websocketPreconnect: true,
      websocketWarmup: undefined,
    },
  );
  assert.throws(() => NodeTransport.resolve({}), /Responses transport/);
  assert.throws(() => NodeTransport.openAi({ apiKey: " " }), /non-empty/);
});

test("subagents are an explicit branded Rust extension", () => {
  assert.deepEqual(Object.keys(Subagents), ["create"]);
  const subagents = Subagents.create({ maxConcurrency: 7 });
  const handler = () => "pong";
  assert.deepEqual(resolveTools([{
    name: "ping",
    description: "Return pong.",
    handler,
  }, ...subagents]), {
    tools: {
      ping: { description: "Return pong.", handler },
    },
    subagents: { max_concurrency: 7 },
  });
  assert.equal(Object.isFrozen(subagents), true);
  assert.equal(Object.isFrozen(subagents[0]), true);
  assert.throws(() => resolveTools([{ maxConcurrency: 7 }]), /named tools/);
  assert.throws(
    () => resolveTools([...subagents, ...subagents]),
    /only be included once/,
  );
  assert.throws(() => Subagents.create({ maxConcurrency: 0 }), /positive safe integer/);
});
