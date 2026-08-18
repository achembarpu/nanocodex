import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { WebSocketServer } from "ws";

import { Actions, Agent } from "../node/index.mjs";
import { createNodeHost } from "../node/host.mjs";

const SESSION_IDS = Object.freeze({
  primary: "018f1f9a-7b3c-7a01-8000-000000000001",
  original: "018f1f9a-7b3c-7a02-8000-000000000002",
  resumed: "018f1f9a-7b3c-7a03-8000-000000000003",
  embedded: "018f1f9a-7b3c-7a04-8000-000000000004",
  left: "018f1f9a-7b3c-7a05-8000-000000000005",
  right: "018f1f9a-7b3c-7a06-8000-000000000006",
});

const createWarmAgent = (options) => Agent.create({
  ...options,
  websocketWarmup: true,
});
const PACKAGE_VERSION = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

test("Node host opens application sockets through MPP", async () => {
  const socket = new ManagedSocket();
  const endpoints = [];
  const host = createNodeHost({
    mpp: {
      async ws(endpoint) {
        endpoints.push(endpoint);
        return socket;
      },
    },
  });

  assert.equal(JSON.parse(await host.connect("wss://paid.test", "mpp-managed", "session")).status, 101);
  assert.deepEqual(endpoints, ["wss://paid.test"]);
  socket.message('{"type":"paid"}');
  assert.equal(JSON.parse(await host.next(1, 10)).text, '{"type":"paid"}');
  assert.equal(JSON.parse(await host.send(1, "request")).ok, true);
  assert.deepEqual(socket.sent.map(JSON.parse), [{ mpp: "message", data: "request" }]);
  socket.close(3008, "requested voucher amount exceeds local maxDeposit");
  assert.deepEqual(JSON.parse(await host.next(1, 10)), {
    kind: "error",
    detail: "MPP WebSocket payment flow failed with code 3008: requested voucher amount exceeds local maxDeposit",
    reconnectable: false,
  });
  host.close(1);
});

test("Node host loads and calls deferred Mercator MCP tools", async () => {
  const calls = [];
  const host = createNodeHost({
    mcpServers: {
      mercator: {
        description: "Deterministic Mercator fixture.",
        client: {
          async listTools() {
            return {
              tools: [{
                name: "search_services",
                description: "Search paid services.",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              }],
            };
          },
          async callTool(input) {
            calls.push(input);
            return { content: [{ type: "text", text: "node-mercator-ok" }] };
          },
        },
      },
    },
  });

  try {
    await host.ready();
    const definitions = JSON.parse(host.toolDefinitions());
    assert.deepEqual(definitions.map((definition) => definition.name ?? definition.type), [
      "tool_search",
      "mcp__mercator__search_services",
    ]);
    assert.equal(definitions[1].defer_loading, true);
    const execution = JSON.parse(await host.executeCode(
      "text(await tools.mcp__mercator__search_services({ query: 'weather' }));",
      "node-session",
      "node-exec",
    ));
    assert.equal(execution.success, true);
    assert.match(JSON.stringify(execution.output), /node-mercator-ok/);
    assert.deepEqual(calls, [{
      name: "search_services",
      arguments: { query: "weather" },
    }]);
  } finally {
    await host.dispose();
  }
});

test("Node host preserves structured WebSocket handshake rejection detail", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "3",
    });
    response.end('{"error":"slow down"}');
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const endpoint = `ws://127.0.0.1:${server.address().port}`;

  try {
    await assert.rejects(
      createNodeHost().connect(endpoint, "test-key", SESSION_IDS.primary),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.body, '{"error":"slow down"}');
        assert.equal(error.retryAfter, 3);
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("Node-hosted WASM preserves follow-ons, cache identity, events, and custom tools", async () => {
  const server = await startServer();
  const events = [];
  const agent = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: server.url,
    thinking: "none",
    reasoningMode: "pro",
    sessionId: SESSION_IDS.primary,
    tools: {
      multiply: {
        description: "Multiply two integers.",
        parameters: {
          type: "object",
          properties: { left: { type: "integer" }, right: { type: "integer" } },
          required: ["left", "right"],
          additionalProperties: false,
        },
        handler: ({ left, right }) => left * right,
      },
    },
  });
  const watch = agent.events.watch();
  watch.onEvent((event) => events.push(event));

  const scenario = (async () => {
    const socket = await server.connection;
    assert.equal(socket.request.headers.authorization, "Bearer test-key");
    assert.equal(socket.request.headers["user-agent"], `nanocodex-wasm/${PACKAGE_VERSION}`);
    assert.equal(socket.request.headers["session-id"], SESSION_IDS.primary);
    const reader = messageReader(socket);

    const warmup = await reader.next();
    assert.equal(warmup.generate, false);
    assert.equal(warmup.reasoning.mode, "pro");
    assert.equal(warmup.reasoning.effort, "none");
    assert.equal(warmup.input[0].tools[0].name, "exec");
    assert.match(warmup.input[0].tools[0].description, /tools\.multiply/);
    sendWarmup(socket, "resp-warmup");

    const generation = await reader.next();
    assert.equal(generation.previous_response_id, "resp-warmup");
    assert.equal(generation.reasoning.effort, "none");
    assert.equal(generation.service_tier, undefined);
    sendCompleted(socket, "resp-tool", [{
      type: "custom_tool_call",
      call_id: "call-exec",
      name: "exec",
      input: "text(await tools.multiply({ left: 6, right: 7 }));",
    }]);

    const continuation = await reader.next();
    assert.equal(continuation.previous_response_id, "resp-tool");
    assert.equal(continuation.reasoning.effort, "none");
    assert.match(JSON.stringify(continuation.input), /42/);
    sendFinal(socket, "resp-first", "42");

    const followOn = await reader.next();
    assert.equal(followOn.previous_response_id, undefined);
    assert.equal(followOn.reasoning.effort, "high");
    assert.equal(followOn.service_tier, "priority");
    const replay = JSON.stringify(followOn.input);
    assert.match(replay, /Use multiply/);
    assert.match(replay, /42/);
    assert.match(replay, /Add one/);
    sendFinal(socket, "resp-second", "43");
  })();

  const firstTurn = agent.turn.prompt({ input: "Use multiply for 6 × 7." });
  const first = await firstTurn.result();
  assert.equal(first.finalMessage, "42");
  assert.deepEqual(first.usage, {
    input_tokens: 20,
    cached_input_tokens: 10,
    cache_write_input_tokens: 0,
    output_tokens: 4,
    reasoning_output_tokens: 2,
    total_tokens: 24,
    estimated_cost: {
      usd: "0.000175",
      input_usd: "0.00005",
      cached_input_usd: "0.000005",
      cache_write_input_usd: "0",
      output_usd: "0.00012",
      service_tier: "standard",
    },
    cost_status: "estimated_from_usage",
  });
  assert.strictEqual(Actions.turn.getUsage(first), first.usage);
  await agent.session.setThinking("high");
  await agent.session.setFastMode(true);
  const second = await Actions.turn.getResult(
    Actions.turn.prompt(agent, { input: "Add one to that result." }),
  );
  assert.equal(second.finalMessage, "43");
  await scenario;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.connections, 1);
  assert.equal(events.filter((event) => event.type === "run.completed").length, 2);
  assert.equal(
    events.find((event) => event.type === "run.completed")?.payload.estimated_cost.usd,
    "0.000175",
  );
  assert.ok(events.some((event) => event.type === "tool.call" && event.payload.tool === "multiply"));
  watch.off();
  agent.dispose();
  await server.close();
});

test("WASM snapshots resume authoritative history in a fresh agent", async () => {
  const originalServer = await startServer();
  const original = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: originalServer.url,
    thinking: "none",
    instructions: "durable wasm instructions",
    sessionId: SESSION_IDS.original,
    workspace: "/virtual/original-workspace",
  });
  const originalScenario = (async () => {
    const socket = await originalServer.connection;
    const reader = messageReader(socket);
    await reader.next();
    sendWarmup(socket, "resp-warmup");
    await reader.next();
    sendFinal(socket, "resp-first", "stored");
  })();
  const first = await original.turn.prompt({ input: "remember cobalt" }).result();
  assert.equal(first.finalMessage, "stored");
  const snapshot = first.snapshot;
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.workspace, "/virtual/original-workspace");
  assert.strictEqual(Actions.turn.getSnapshot(first), snapshot);
  await originalScenario;
  original.dispose();
  await originalServer.close();

  const resumedServer = await startServer();
  const resumed = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: resumedServer.url,
    thinking: "none",
    instructions: "durable wasm instructions",
    sessionId: SESSION_IDS.resumed,
    resume: snapshot,
  });
  const resumedScenario = (async () => {
    const socket = await resumedServer.connection;
    assert.equal(socket.request.headers["session-id"], SESSION_IDS.resumed);
    const request = await messageReader(socket).next();
    assert.equal(request.previous_response_id, undefined);
    assert.equal(request.prompt_cache_key, snapshot.prompt_cache_key);
    assert.match(JSON.stringify(request.input), /remember cobalt/);
    assert.match(JSON.stringify(request.input), /what did I ask/);
    sendFinal(socket, "resp-resumed", "cobalt");
  })();
  assert.equal(
    (await resumed.turn.prompt({ input: "what did I ask you to remember?" }).result()).finalMessage,
    "cobalt",
  );
  await resumedScenario;

  const spawnedConnection = new Promise((resolve) => {
    resumedServer.websocketServer.once("connection", (socket, request) => {
      socket.request = request;
      resolve(socket);
    });
  });
  const spawned = await resumed.session.spawn();
  const spawnedScenario = (async () => {
    const socket = await spawnedConnection;
    const reader = messageReader(socket);
    const warmup = await reader.next();
    assert.equal(warmup.prompt_cache_key, snapshot.prompt_cache_key);
    sendWarmup(socket, "resp-spawn-warmup");
    await reader.next();
    sendFinal(socket, "resp-spawned", "fresh");
  })();
  assert.equal(
    (await spawned.turn.prompt({ input: "start fresh" }).result()).finalMessage,
    "fresh",
  );
  await spawnedScenario;
  spawned.dispose();
  resumed.dispose();
  await resumedServer.close();
});

test("Node can load an application-owned web module and resume Codex rollout history", async () => {
  const server = await startServer();
  const wasm = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const canonicalContext = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "remember amber" }],
  };
  const snapshot = {
    version: 1,
    model: "gpt-5.6-sol",
    lineage_id: "codex-rollout-lineage",
    prompt_cache_key: "codex-rollout-lineage",
    workspace: process.cwd(),
    canonical_context: canonicalContext,
    history: [
      canonicalContext,
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "stored" }],
        status: "completed",
      },
    ],
  };
  const agent = await createWarmAgent({
    apiKey: "test-key",
    module: wasm,
    websocketUrl: server.url,
    thinking: "none",
    sessionId: SESSION_IDS.embedded,
    resume: snapshot,
  });
  const scenario = (async () => {
    const socket = await server.connection;
    const request = await messageReader(socket).next();
    assert.equal(request.previous_response_id, undefined);
    assert.equal(request.prompt_cache_key, snapshot.prompt_cache_key);
    assert.match(JSON.stringify(request.input), /remember amber/);
    assert.match(JSON.stringify(request.input), /what color/);
    sendFinal(socket, "resp-rollout-resumed", "amber");
  })();

  assert.equal(
    (await agent.turn.prompt({ input: "what color did I ask you to remember?" }).result())
      .finalMessage,
    "amber",
  );
  await scenario;
  agent.dispose();
  await server.close();
});

test("independent agents keep their host connections isolated", async () => {
  const leftServer = await startServer();
  const rightServer = await startServer();
  const left = await createWarmAgent({
    apiKey: "left-key",
    websocketUrl: leftServer.url,
    thinking: "none",
    sessionId: SESSION_IDS.left,
    tools: {
      leftTool: {
        description: "Only the left agent can see this tool.",
        parameters: { type: "object" },
        handler: async () => "left",
      },
    },
  });
  const right = await createWarmAgent({
    apiKey: "right-key",
    websocketUrl: rightServer.url,
    thinking: "none",
    sessionId: SESSION_IDS.right,
    tools: {
      rightTool: {
        description: "Only the right agent can see this tool.",
        parameters: { type: "object" },
        handler: async () => "right",
      },
    },
  });

  const leftTools = globalThis.nanocodexHost.toolDefinitions(SESSION_IDS.left);
  const rightTools = globalThis.nanocodexHost.toolDefinitions(SESSION_IDS.right);
  assert.match(leftTools, /leftTool/);
  assert.doesNotMatch(leftTools, /rightTool/);
  assert.match(rightTools, /rightTool/);
  assert.doesNotMatch(rightTools, /leftTool/);

  const serve = async (server, sessionId, message) => {
    const socket = await server.connection;
    assert.equal(socket.request.headers["session-id"], sessionId);
    const reader = messageReader(socket);
    await reader.next();
    sendWarmup(socket, `${sessionId}-warmup`);
    await reader.next();
    sendFinal(socket, `${sessionId}-final`, message);
  };
  const scenarios = Promise.all([
    serve(leftServer, SESSION_IDS.left, "LEFT"),
    serve(rightServer, SESSION_IDS.right, "RIGHT"),
  ]);

  // Prompt the first agent only after the second factory has installed its
  // host. This regresses the old realm-global host overwrite.
  const [leftResult, rightResult] = (await Promise.all([
    left.turn.prompt({ input: "left" }).result(),
    right.turn.prompt({ input: "right" }).result(),
  ])).map((result) => result.finalMessage);
  assert.equal(leftResult, "LEFT");
  assert.equal(rightResult, "RIGHT");
  await scenarios;

  left.dispose();
  right.dispose();
  await Promise.all([leftServer.close(), rightServer.close()]);
});

async function startServer() {
  const websocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    websocketServer.once("listening", resolve);
    websocketServer.once("error", reject);
  });
  let resolveConnection;
  const connection = new Promise((resolve) => { resolveConnection = resolve; });
  const state = {
    websocketServer,
    connection,
    connections: 0,
    get url() {
      return `ws://127.0.0.1:${websocketServer.address().port}`;
    },
    close() {
      for (const socket of websocketServer.clients) socket.terminate();
      return new Promise((resolve, reject) => websocketServer.close((error) => error ? reject(error) : resolve()));
    },
  };
  websocketServer.on("connection", (socket, request) => {
    state.connections += 1;
    socket.request = request;
    resolveConnection(socket);
  });
  return state;
}

function messageReader(socket) {
  const messages = [];
  let waiter;
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString("utf8"));
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(value);
    } else {
      messages.push(value);
    }
  });
  return {
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve) => { waiter = resolve; });
    },
  };
}

class ManagedSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(message) {
    this.sent.push(message);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    const event = new Event("close");
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }

  message(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function sendWarmup(socket, responseId) {
  socket.send(JSON.stringify({
    type: "response.completed",
    response: { id: responseId, usage: null },
  }));
}

function sendFinal(socket, responseId, text) {
  sendCompleted(socket, responseId, [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  }]);
}

function sendCompleted(socket, responseId, output) {
  socket.send(JSON.stringify({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output,
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 12,
      },
    },
  }));
}
