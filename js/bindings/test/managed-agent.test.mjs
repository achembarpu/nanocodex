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

test("managed event history requests one bounded chronological page before a cursor", async () => {
  const requests = [];
  const agent = await Agent.create({
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST") return Response.json({ agent_id: agentId }, { status: 201 });
      return Response.json({
        data: [eventData("7"), eventData("8")],
        has_more: true,
        latest_cursor: "12",
      });
    },
  });

  const page = await agent.events.page({ before: "9", limit: 2 });
  assert.deepEqual(page.data.map((event) => event.cursor), ["7", "8"]);
  assert.equal(page.hasMore, true);
  assert.equal(page.latestCursor, "12");
  assert.equal(new URL(requests[1].url).search, "?limit=2&before=9");
  assert.equal(requests.length, 2, "one create plus one history request");
  await assert.rejects(() => agent.events.page({ before: "0" }), /positive decimal/);
  await assert.rejects(() => agent.events.page({ limit: 257 }), /1 through 256/);
});

test("prompts and a watcher multiplex one active managed event request without stealing events", async () => {
  const connections = [];
  let activeConnections = 0;
  let maximumActiveConnections = 0;
  let eventRequests = 0;
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/agents") {
      return Response.json({ agent_id: agentId }, { status: 201 });
    }
    if (request.method === "POST" && url.pathname.endsWith("/turns")) {
      const body = await request.json();
      return Response.json({
        turn_id: body.id,
        state: "accepted",
        accepted_cursor: "0",
        terminal_cursor: null,
      }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      eventRequests += 1;
      activeConnections += 1;
      maximumActiveConnections = Math.max(maximumActiveConnections, activeConnections);
      const connection = controlledEventStream(request.signal, () => { activeConnections -= 1; });
      connections.push(connection);
      return connection.response;
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  const agent = await Agent.create({ baseUrl: origin, fetch });
  const watched = [];
  const watching = (async () => {
    for await (const event of agent.events.watch()) {
      watched.push(event);
      if (watched.length === 3) break;
    }
  })();
  const turns = [1, 2, 3].map((number) => agent.turn.prompt({
    id: `turn-${number}`,
    input: `prompt ${number}`,
    idempotencyKey: `request-${number}`,
  }));
  const results = turns.map((turn) => turn.result());
  await Promise.all(turns.map((turn) => turn.accepted()));
  await waitFor(() => connections.length === 1);
  connections[0].send([1, 2, 3].map((number) => sse(String(number), "turn_completed", {
    cursor: String(number),
    created_at: number,
    turn_id: `turn-${number}`,
    type: "turn_completed",
    id: `turn-${number}`,
    final_message: `done ${number}`,
    usage: null,
  })).join(""));

  assert.deepEqual((await Promise.all(results)).map((result) => result.finalMessage), [
    "done 1",
    "done 2",
    "done 3",
  ]);
  await watching;
  assert.deepEqual(watched.map((event) => event.data.id), ["turn-1", "turn-2", "turn-3"]);
  assert.equal(eventRequests, 1);
  assert.equal(maximumActiveConnections, 1);
  await waitFor(() => activeConnections === 0);
});

test("shared event replay reconnect resolves one turn and delivers each cursor exactly once", async () => {
  const connections = [];
  const requestedCursors = [];
  let activeConnections = 0;
  let maximumActiveConnections = 0;
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/agents") {
      return Response.json({ agent_id: agentId }, { status: 201 });
    }
    if (request.method === "POST" && url.pathname.endsWith("/turns")) {
      return Response.json({
        turn_id: "turn-1",
        state: "accepted",
        accepted_cursor: "5",
        terminal_cursor: null,
      }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      requestedCursors.push(url.searchParams.get("cursor"));
      activeConnections += 1;
      maximumActiveConnections = Math.max(maximumActiveConnections, activeConnections);
      const connection = controlledEventStream(request.signal, () => { activeConnections -= 1; });
      connections.push(connection);
      return connection.response;
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  const agent = await Agent.create({ baseUrl: origin, fetch });
  const observed = [];
  const watching = (async () => {
    for await (const event of agent.events.watch({ cursor: "5" })) {
      observed.push(event.cursor);
      if (event.type === "turn_completed") break;
    }
  })();
  const turn = agent.turn.prompt({
    id: "turn-1",
    input: "hello",
    idempotencyKey: "request-1",
  });
  const firstResult = turn.result();
  await turn.accepted();
  await waitFor(() => connections.length === 1);
  connections[0].send(`retry: 0\n\n${sse("6", "event", {
    cursor: "6",
    created_at: 10,
    turn_id: "turn-1",
    type: "event",
    event: { type: "reasoning" },
  })}`);
  connections[0].close();
  await waitFor(() => connections.length === 2);
  connections[1].send(`${sse("6", "event", {
    cursor: "6",
    created_at: 10,
    turn_id: "turn-1",
    type: "event",
    event: { type: "reasoning" },
  })}${sse("7", "turn_completed", {
    cursor: "7",
    created_at: 11,
    turn_id: "turn-1",
    type: "turn_completed",
    id: "turn-1",
    final_message: "done",
    usage: null,
  })}`);

  assert.deepEqual(await firstResult, {
    turnId: "turn-1",
    finalMessage: "done",
    usage: null,
    cursor: "7",
  });
  assert.strictEqual(await turn.result(), await turn.result());
  await watching;
  assert.deepEqual(requestedCursors, ["5", "6"]);
  assert.deepEqual(observed, ["6", "7"]);
  assert.equal(maximumActiveConnections, 1);
  await waitFor(() => activeConnections === 0);
});

test("turn result without an event watcher opens one shared stream and preserves idempotency", async () => {
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

function eventData(cursor) {
  return {
    cursor,
    created_at: Number(cursor),
    turn_id: null,
    type: "event",
    event: { type: "assistant.message", payload: { text: cursor } },
  };
}

function controlledEventStream(signal, onClose) {
  let controller;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", finish);
    onClose();
    try { controller.close(); } catch {}
  };
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel: finish,
  });
  signal.addEventListener("abort", finish, { once: true });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    send(value) {
      if (!closed) controller.enqueue(new TextEncoder().encode(value));
    },
    close: finish,
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for managed event state");
}

function sse(id, event, data) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
