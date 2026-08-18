import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

import { Agent } from "../browser/index.mjs";

const createWarmAgent = (options) => Agent.create({
  ...options,
  websocketWarmup: true,
});

test("web-target WASM runs the shared model loop through the browser host", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const connection = new Promise((resolve) => server.once("connection", resolve));
  const events = [];
  const wasm = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const endpoint = `ws://127.0.0.1:${server.address().port}`;
  const agent = await createWarmAgent({
    apiKey: "test-key",
    WebSocketImpl: WebSocket,
    module: wasm,
    websocketUrl: endpoint,
    thinking: "low",
    sessionId: "018f1f9a-7b3c-7a07-8000-000000000007",
  });
  const watch = agent.events.watch({ includeAllSessions: true });
  watch.onEvent((event) => events.push(event));

  const scenario = (async () => {
    const socket = await connection;
    const reader = messageReader(socket);
    await reader.next();
    send(socket, { type: "response.completed", response: { id: "web-warmup", usage: null } });
    const generation = await reader.next();
    assert.equal(generation.previous_response_id, "web-warmup");
    send(socket, {
      type: "response.completed",
      response: {
        id: "web-final",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "WEB_WASM_OK" }],
        }],
        usage: null,
      },
    });
  })();

  assert.equal(
    (await agent.turn.prompt({ input: "Reply with WEB_WASM_OK." }).result()).finalMessage,
    "WEB_WASM_OK",
  );
  await scenario;

  const branchConnection = new Promise((resolve) => server.once("connection", resolve));
  const branch = await agent.session.fork();
  assert.notEqual(branch.sessionId, agent.sessionId);
  assert.throws(
    () => branch.turn.prompt({
      input: [{ type: "local_image", path: "/private/model-input.png" }],
    }),
    /cannot reference local filesystem paths/,
  );
  assert.throws(
    () => branch.turn.prompt({
      input: [{ type: "local_audio", path: "/private/model-input.wav" }],
    }),
    /cannot reference local filesystem paths/,
  );
  const branchTurn = branch.turn.prompt({ input: [
    { type: "image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
    { type: "text", text: "Reply with WEB_FORK_OK." },
  ] });
  const branchSocket = await branchConnection;
  const branchReader = messageReader(branchSocket);
  const branchRequest = await branchReader.next();
  assert.equal(branchRequest.previous_response_id, undefined);
  const replay = JSON.stringify(branchRequest.input);
  assert.match(replay, /Reply with WEB_WASM_OK/);
  assert.match(replay, /WEB_WASM_OK/);
  assert.match(replay, /WEB_FORK_OK/);
  assert.match(replay, /input_image/);
  send(branchSocket, {
    type: "response.completed",
    response: {
      id: "web-branch-final",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "WEB_FORK_OK" }],
      }],
      usage: null,
    },
  });
  assert.equal((await branchTurn.result()).finalMessage, "WEB_FORK_OK");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === "run.completed").length, 2);

  watch.off();
  branch.dispose();
  agent.dispose();
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("web-target WASM directly dispatches a CSP-safe application tool", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const connection = new Promise((resolve) => server.once("connection", resolve));
  const events = [];
  const wasm = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const agent = await createWarmAgent({
    apiKey: "test-key",
    WebSocketImpl: WebSocket,
    module: wasm,
    sessionId: "018f1f9a-7b3c-7a07-8000-000000000008",
    thinking: "low",
    toolMode: "direct",
    tools: {
      runtimeInfo: {
        description: "Return the runtime.",
        parameters: { type: "object", additionalProperties: false },
        handler: () => ({ runtime: "worker" }),
      },
    },
    websocketUrl: `ws://127.0.0.1:${server.address().port}`,
  });
  const watch = agent.events.watch();
  watch.onEvent((event) => events.push(event));
  try {
    const turn = agent.turn.prompt({ input: "Call runtimeInfo." });
    const socket = await connection;
    const reader = messageReader(socket);
    const warmup = await reader.next();
    const toolPrefix = warmup.input.find((item) => item.type === "additional_tools");
    assert.deepEqual(toolPrefix.tools.map((tool) => tool.name), ["runtimeInfo"]);
    send(socket, { type: "response.completed", response: { id: "direct-warmup", usage: null } });
    const generation = await reader.next();
    assert.equal(generation.previous_response_id, "direct-warmup");
    send(socket, {
      type: "response.completed",
      response: {
        id: "direct-tool",
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call-runtime",
          name: "runtimeInfo",
          arguments: "{}",
        }],
        usage: null,
      },
    });
    const continuation = await reader.next();
    assert.equal(continuation.input[0].type, "function_call_output");
    assert.equal(continuation.input[0].call_id, "call-runtime");
    assert.deepEqual(JSON.parse(continuation.input[0].output), { runtime: "worker" });
    send(socket, {
      type: "response.completed",
      response: {
        id: "direct-final",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "worker" }],
        }],
        usage: null,
      },
    });
    assert.equal((await turn.result()).finalMessage, "worker");
    assert.equal(events.some((event) =>
      event.type === "tool.call" && event.payload.tool === "runtimeInfo"), true);
    assert.equal(events.some((event) =>
      event.type === "tool.result" && event.payload.status === "completed"), true);
  } finally {
    watch.off();
    agent.dispose();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("web-target WASM exposes browser bash and Rust apply_patch as standard tools", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const connection = new Promise((resolve) => server.once("connection", resolve));
  const wasm = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const files = new Map([["/workspace/note.txt", new TextEncoder().encode("before\n")]]);
  const workspace = {
    root: "/workspace",
    async list() { return []; },
    async readFile(path) {
      const value = files.get(path.startsWith("/") ? path : `/workspace/${path}`);
      if (!value) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return value;
    },
    async writeFile(path, contents) {
      files.set(path.startsWith("/") ? path : `/workspace/${path}`, typeof contents === "string"
        ? new TextEncoder().encode(contents)
        : new Uint8Array(contents.buffer ?? contents, contents.byteOffset ?? 0, contents.byteLength));
    },
    async remove(path) {
      const resolved = path.startsWith("/") ? path : `/workspace/${path}`;
      if (!files.delete(resolved)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
    async mkdir() {},
  };
  const agent = await createWarmAgent({
    apiKey: "test-key",
    WebSocketImpl: WebSocket,
    module: wasm,
    filesystem: workspace,
    filesystemTools: false,
    sessionId: "018f1f9a-7b3c-7a07-8000-000000000010",
    thinking: "low",
    tools: {
      exec_command: {
        description: "Run browser bash.",
        parameters: { type: "object", required: ["cmd"] },
        handler: () => ({ output: "", wall_time_seconds: 0, exit_code: 0 }),
      },
    },
    websocketUrl: `ws://127.0.0.1:${server.address().port}`,
  });
  try {
    const turn = agent.turn.prompt({ input: "Update note.txt with apply_patch." });
    const socket = await connection;
    const reader = messageReader(socket);
    const warmup = await reader.next();
    const toolPrefix = warmup.input.find((item) => item.type === "additional_tools");
    assert.deepEqual(toolPrefix.tools.map((tool) => tool.name), [
      "exec",
      "exec_command",
      "apply_patch",
    ]);
    assert.equal(toolPrefix.tools.some((tool) => tool.name === "read_file"), false);
    send(socket, { type: "response.completed", response: { id: "workspace-warmup", usage: null } });
    await reader.next();
    send(socket, {
      type: "response.completed",
      response: {
        id: "workspace-patch",
        status: "completed",
        output: [{
          type: "custom_tool_call",
          call_id: "call-apply-patch",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: note.txt\n@@\n-before\n+after\n*** End Patch",
        }],
        usage: null,
      },
    });
    const continuation = await reader.next();
    assert.equal(continuation.input[0].type, "custom_tool_call_output");
    assert.equal(continuation.input[0].call_id, "call-apply-patch");
    assert.match(continuation.input[0].output, /Success.*M note\.txt/s);
    assert.equal(new TextDecoder().decode(files.get("/workspace/note.txt")), "after\n");
    send(socket, {
      type: "response.completed",
      response: {
        id: "workspace-final",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "updated" }],
        }],
        usage: null,
      },
    });
    assert.equal((await turn.result()).finalMessage, "updated");
  } finally {
    agent.dispose();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("web-target WASM keeps remote MCP deferred behind tool_search and Code Mode", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const connection = new Promise((resolve) => server.once("connection", resolve));
  const events = [];
  const calls = [];
  const wasm = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const mcpClient = {
    async listTools() {
      return {
        tools: [{
          name: "echo",
          description: "Echo a deterministic MCP fixture message.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
        }],
      };
    },
    async callTool({ name, arguments: input }) {
      calls.push({ name, input });
      return {
        content: [{ type: "text", text: `fixture:${input.message}` }],
        isError: false,
      };
    },
  };
  const agent = await createWarmAgent({
    apiKey: "test-key",
    WebSocketImpl: WebSocket,
    module: wasm,
    sessionId: "018f1f9a-7b3c-7a07-8000-000000000009",
    thinking: "low",
    mcp: {
      fixture: {
        client: mcpClient,
        description: "Deterministic remote MCP fixture.",
      },
    },
    websocketUrl: `ws://127.0.0.1:${server.address().port}`,
  });
  const watch = agent.events.watch();
  watch.onEvent((event) => events.push(event));
  let turn;
  try {
    turn = agent.turn.prompt({ input: "Find and call the remote MCP echo tool." });
    const socket = await connection;
    const reader = messageReader(socket);
    const warmup = await reader.next();
    const toolPrefix = warmup.input.find((item) => item.type === "additional_tools");
    assert.deepEqual(toolPrefix.tools.map((tool) => tool.name ?? tool.type), ["exec", "tool_search"]);
    assert.doesNotMatch(toolPrefix.tools[0].description, /mcp__fixture__echo/);
    assert.equal(toolPrefix.tools.some((tool) => tool.name === "mcp__fixture__echo"), false);
    send(socket, { type: "response.completed", response: { id: "mcp-warmup", usage: null } });

    const generation = await reader.next();
    assert.equal(generation.previous_response_id, "mcp-warmup");
    send(socket, {
      type: "response.completed",
      response: {
        id: "mcp-search",
        status: "completed",
        output: [{
          type: "tool_search_call",
          call_id: "search-mcp",
          execution: "client",
          arguments: { query: "echo deterministic message", limit: 1 },
        }],
        usage: null,
      },
    });

    const searched = await reader.next();
    assert.equal(searched.previous_response_id, "mcp-search");
    assert.equal(searched.input[0].type, "tool_search_output");
    assert.equal(searched.input[0].tools[0].type, "namespace");
    assert.equal(searched.input[0].tools[0].name, "mcp__fixture__");
    assert.deepEqual(searched.input[0].tools[0].tools.map((tool) => tool.name), ["echo"]);
    send(socket, {
      type: "response.completed",
      response: {
        id: "mcp-exec",
        status: "completed",
        output: [{
          type: "custom_tool_call",
          call_id: "call-exec-mcp",
          name: "exec",
          input: "text(await tools.mcp__fixture__echo({ message: 'hello' }));",
        }],
        usage: null,
      },
    });

    const called = await reader.next();
    assert.equal(called.previous_response_id, "mcp-exec");
    assert.equal(called.input[0].type, "custom_tool_call_output");
    assert.match(JSON.stringify(called.input[0].output), /fixture:hello/);
    send(socket, {
      type: "response.completed",
      response: {
        id: "mcp-final",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "MCP_WASM_OK" }],
        }],
        usage: null,
      },
    });

    assert.equal((await turn.result()).finalMessage, "MCP_WASM_OK");
    assert.deepEqual(calls, [{ name: "echo", input: { message: "hello" } }]);
    assert.equal(events.some((event) =>
      event.type === "tool.call" && event.payload.tool === "mcp__fixture__echo"), true);
  } finally {
    turn?.dispose();
    watch.off();
    await agent.session.shutdown();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

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

function send(socket, value) {
  socket.send(JSON.stringify(value));
}
