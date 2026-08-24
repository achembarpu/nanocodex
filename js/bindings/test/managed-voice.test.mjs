import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Agent } from "../managed/index.mjs";
import { createManagedBrowserVoice } from "../managed/Voice.mjs";

const AGENT_ID = "019d2f5d-7491-7000-8000-000000000001";

test("managed browser voice keeps protocol in Rust and routes the selected durable Agent", async () => {
  const wasm = await readFile(new URL("../pkg-web/nanocodex_bg.wasm", import.meta.url));
  const module = await WebAssembly.compile(wasm);
  const requests = [];
  const agent = Agent.open(AGENT_ID, {
    baseUrl: "https://managed.example",
    fetch: async (input, init) => {
      const url = new URL(input);
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ body, method: init?.method ?? "GET", path: url.pathname });
      if (url.pathname.endsWith("/realtime/start")) {
        return Response.json({
          context: {
            workspace: "/workspace",
            history: [{
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "continue the durable chat" }],
            }],
          },
        });
      }
      if (url.pathname.endsWith("/realtime/delegate")) {
        return Response.json({ route: "started", turn_id: "voice-turn" });
      }
      if (url.pathname.endsWith("/turns/voice-turn/cancel")) {
        return Response.json({ turn_id: "voice-turn", state: "cancelling" });
      }
      if (url.pathname.endsWith("/realtime/stop")) {
        return Response.json({ stopped: true });
      }
      throw new Error(`unexpected managed voice request: ${url}`);
    },
  });
  const voice = await createManagedBrowserVoice(agent, "cove", { module });

  await voice.start();
  const call = JSON.parse(voice.callBody("v=managed-offer"));
  const provider = JSON.parse(call.call_body);
  assert.equal(call.managed_agent_id, AGENT_ID);
  assert.equal(call.session_id, AGENT_ID);
  assert.equal(provider.session.model, "gpt-live-1-codex");
  assert.match(provider.session.instructions, /continue the durable chat/);
  assert.match(voice.sidebandUrl("rtc_managed"), new RegExp(`managed_agent_id=${AGENT_ID}`));

  const delegation = JSON.stringify({
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id: "delegation-1",
      content: [{ type: "input_text", text: "ship it" }],
    },
  });
  await voice.realtimeMessage(delegation);
  await voice.realtimeMessage(delegation);
  assert.equal(requests[1].body.operation_id, requests[2].body.operation_id);
  assert.equal(voice.agentEvent({ turnId: "typed-turn", event: { type: "run.started" } }), undefined);
  assert.equal(typeof voice.agentEvent({ turnId: "voice-turn", event: { type: "run.started" } }), "string");
  assert.equal(await voice.cancel(), true);
  await voice.stop();
  voice.free();

  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
    ["POST", `/v1/agents/${AGENT_ID}/realtime/start`],
    ["POST", `/v1/agents/${AGENT_ID}/realtime/delegate`],
    ["POST", `/v1/agents/${AGENT_ID}/realtime/delegate`],
    ["POST", `/v1/agents/${AGENT_ID}/turns/voice-turn/cancel`],
    ["POST", `/v1/agents/${AGENT_ID}/realtime/stop`],
  ]);
  assert.match(requests[1].body.input, /<realtime_delegation>/);
  assert.equal(typeof requests[1].body.voice_session_id, "string");
  assert.equal(typeof requests[1].body.operation_id, "string");
  assert.equal(typeof requests[0].body.operation_id, "string");
  assert.equal(typeof requests[4].body.operation_id, "string");
});
