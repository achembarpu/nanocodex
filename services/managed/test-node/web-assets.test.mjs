import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import ts from "typescript";

test("the emitted inline browser client is valid JavaScript", async () => {
  const app = await emittedApp();
  new vm.Script(app, { filename: "app.js" });
});

test("the browser operator uses an in-memory account key for creation and owner routes", async () => {
  const app = await emittedApp();
  const elements = new Map();
  const stored = new Map();
  const storedSnapshots = [];
  const requests = [];
  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        addEventListener(type, listener) { listeners.set(type, listener); },
        append() {},
        dataset: {},
        disabled: false,
        listeners,
        replaceChildren() {},
        scrollHeight: 0,
        scrollTop: 0,
        textContent: "",
        value: "",
      });
    }
    return elements.get(id);
  };
  const receipt = {
    agent_id: "01991f70-0000-7000-8000-000000000001",
    session_id: "01991f70-0000-7000-8000-000000000001",
    events_url: "https://example.test/v1/agents/01991f70-0000-7000-8000-000000000001/events",
    websocket_url: "wss://example.test/v1/agents/01991f70-0000-7000-8000-000000000001/ws",
  };
  let streamController;
  const pendingStream = new ReadableStream({
    start(controller) { streamController = controller; },
  });
  const fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init });
    if (String(input) === "/v1/agents") return Response.json(receipt, { status: 201 });
    return new Response(pendingStream, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const timers = new Map();
  let nextTimer = 1;
  const context = {
    AbortController,
    console,
    crypto,
    document: {
      createElement: () => element(`created-${elements.size}`),
      getElementById: element,
    },
    fetch,
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      removeItem: (key) => stored.delete(key),
      setItem: (key, value) => {
        stored.set(key, value);
        storedSnapshots.push(JSON.parse(value));
      },
    },
    location: new URL("https://example.test/"),
    Response,
    TextDecoder,
    URL,
    clearTimeout: (id) => timers.delete(id),
    setTimeout: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    window: { addEventListener() {} },
  };
  vm.runInNewContext(app, context, { filename: "app.js" });

  const apiKey = "ncx_live_account_key_that_must_never_be_persisted";
  element("api-key").value = apiKey;
  await element("new-agent").listeners.get("click")();

  assert.equal(requests[0].input, "/v1/agents");
  assert.equal(requests[0].init.headers.authorization, `Bearer ${apiKey}`);
  assert.match(requests[1].input, /\/v1\/agents\/[^/]+\/events\?cursor=0$/);
  assert.equal(requests[1].init.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(element("api-key").value, "");

  await new Promise((resolve) => setImmediate(resolve));
  element("prompt").value = "check owner authentication";
  element("prompt-form").listeners.get("submit")({ preventDefault() {} });
  const turnRequest = requests.find(({ input }) => input.endsWith("/turns"));
  assert.ok(turnRequest);
  assert.equal(turnRequest.init.headers.authorization, `Bearer ${apiKey}`);

  streamController.enqueue(new TextEncoder().encode(
    `id: 3\nevent: turn_completed\ndata: ${JSON.stringify({
      type: "turn_completed",
      cursor: "3",
      id: JSON.parse(turnRequest.init.body).id,
      final_message: "owner authentication complete",
    })}\n\n`,
  ));
  await new Promise((resolve) => setImmediate(resolve));

  const terminalCursorSnapshots = storedSnapshots.filter(({ cursor }) => cursor === "3");
  assert.ok(terminalCursorSnapshots.length > 0);
  assert.equal(terminalCursorSnapshots.every((value) => value.pending === undefined), true);
  assert.equal(terminalCursorSnapshots.every((value) =>
    value.messages.some((message) => message.role === "agent"
      && message.text === "owner authentication complete")), true);

  assert.equal(stored.size, 1);
  const persisted = [...stored.values()][0];
  assert.equal(persisted.includes(apiKey), false);
  assert.equal(
    [...elements.values()].some(({ textContent }) => String(textContent).includes(apiKey)),
    false,
  );
  assert.deepEqual(
    Object.keys(JSON.parse(persisted)).sort(),
    ["active_turns", "agent_id", "cursor", "events_url", "messages", "session_id", "websocket_url"],
  );
  assert.doesNotMatch(app, /agent_token|NANOCODEX_ADMIN_TOKEN|\/sessions/);
});

async function emittedApp() {
  const source = await readFile(new URL("../src/web.ts", import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(transpiled, {
    exports: loaded.exports,
    module: loaded,
    Response,
  });
  return loaded.exports.webAsset("/app.js").text();
}
