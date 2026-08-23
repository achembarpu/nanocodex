import assert from "node:assert/strict";
import test from "node:test";

import { Agent, ManagedError } from "../managed/index.mjs";

const origin = "https://managed.example";
const agentId = "0198d3f0-8844-7000-8000-000000000001";
const apiKey = `ncx_live_${"a".repeat(12)}_${"b".repeat(43)}`;

test("managed Agent covers account-scoped create, list, get, and delete", async () => {
  const calls = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/v1/agents") {
      return Response.json({ agent_id: agentId, events_url: "private", websocket_url: "private" }, { status: 201 });
    }
    if (request.method === "GET" && path === "/v1/agents") {
      return Response.json({ data: [agentId] });
    }
    if (request.method === "GET" && path === `/v1/agents/${agentId}`) {
      return Response.json(agentState());
    }
    if (request.method === "DELETE" && path === `/v1/agents/${agentId}`) {
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const options = { baseUrl: origin, fetch };

  const created = await Agent.create(options);
  assert.equal(created.type, "managed");
  assert.equal(created.id, agentId);
  assert.equal(Object.hasOwn(created, "websocket_url"), false);
  assert.equal(Object.isFrozen(created), true);

  const listed = await Agent.list(options);
  assert.deepEqual(listed.map((agent) => agent.id), [agentId]);
  assert.equal((await Agent.get(agentId, options)).id, agentId);
  assert.equal((await created.state()).latest_event_cursor, "4");
  await created.delete();
  await Agent.delete(agentId, options);

  for (const request of calls) {
    assert.equal(request.credentials, "include");
    assert.equal(request.headers.has("authorization"), false);
  }
});

test("managed server authentication sends only an ncx_live bearer and omits cookies", async () => {
  let captured;
  const agents = await Agent.list({
    baseUrl: origin,
    apiKey,
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return Response.json({ data: [] });
    },
  });
  assert.deepEqual(agents, []);
  assert.equal(captured.credentials, "omit");
  assert.equal(captured.headers.get("authorization"), `Bearer ${apiKey}`);
  assert.deepEqual([...captured.headers.keys()], ["authorization"]);

  await assert.rejects(
    Agent.list({ baseUrl: origin, apiKey: "sk-provider-secret" }),
    /ncx_live bearer key/,
  );
  await assert.rejects(
    Agent.create({ baseUrl: origin, apiKey, env: { provider: "secret" } }),
    /do not accept env/,
  );
  await assert.rejects(
    Agent.create({ baseUrl: origin, headers: { "x-internal": "capability" } }),
    /do not accept headers/,
  );
});

test("prompt preserves its idempotency key and result reconnects after the durable cursor", async () => {
  const requests = [];
  let eventConnections = 0;
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/agents") {
      return Response.json({ agent_id: agentId }, { status: 201 });
    }
    if (request.method === "POST" && url.pathname.endsWith("/turns")) {
      assert.deepEqual(await request.json(), { id: "turn-1", input: "hello" });
      return Response.json({
        turn_id: "turn-1",
        state: "accepted",
        accepted_cursor: "5",
        terminal_cursor: null,
      }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      eventConnections += 1;
      if (eventConnections === 1) {
        assert.equal(url.searchParams.get("cursor"), "5");
        return eventStream([
          "retry: 0\n\n",
          sse("6", "event", {
            cursor: "6",
            created_at: 10,
            turn_id: "turn-1",
            type: "event",
            event: { type: "reasoning" },
          }),
        ]);
      }
      assert.equal(url.searchParams.get("cursor"), "6");
      return eventStream([sse("7", "turn_completed", {
        cursor: "7",
        created_at: 11,
        turn_id: "turn-1",
        type: "turn_completed",
        id: "turn-1",
        final_message: "done",
        usage: null,
      })]);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  const agent = await Agent.create({ baseUrl: origin, fetch });
  const turn = agent.turn.prompt({
    id: "turn-1",
    input: "hello",
    idempotencyKey: "request-1",
  });
  assert.equal(turn.idempotencyKey, "request-1");
  assert.equal(await turn.accepted(), "turn-1");
  assert.deepEqual(await turn.result(), {
    turnId: "turn-1",
    finalMessage: "done",
    usage: null,
    cursor: "7",
  });
  assert.strictEqual(await turn.result(), await turn.result());
  assert.equal(eventConnections, 2);
  const submission = requests.find((request) => request.method === "POST" && request.url.endsWith("/turns"));
  assert.equal(submission.headers.get("idempotency-key"), "request-1");
});

test("terminal managed failures are typed and HTTP failures hide response headers", async () => {
  await assert.rejects(
    Agent.get(agentId, {
      baseUrl: origin,
      fetch: async () => Response.json(
        { error: "not_found", message: "agent does not exist" },
        { status: 404, headers: { "x-private-capability": "secret" } },
      ),
    }),
    (error) => {
      assert(error instanceof ManagedError);
      assert.equal(error.code, "not_found");
      assert.equal(error.status, 404);
      assert.equal(Object.hasOwn(error, "headers"), false);
      return true;
    },
  );
});

function agentState() {
  return {
    agent_id: agentId,
    session_id: agentId,
    has_snapshot: false,
    completed_turns: 0,
    last_active: 1,
    active_turns: [],
    active_turn_details: [],
    agent_loaded: false,
    connected_clients: 0,
    capabilities: {
      durable_turns: true,
      resumable_events: true,
      live_steer: true,
      live_cancel: true,
      workspace: "cloudflare-computer",
      sandbox_escalation: false,
    },
    latest_event_cursor: "4",
    stream_error: null,
  };
}

function eventStream(parts) {
  return new Response(parts.join(""), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function sse(id, event, data) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
