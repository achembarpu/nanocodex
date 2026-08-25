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
      return Response.json({
        data: [agentId],
        summaries: {
          [agentId]: { title: "First task", created_at: 10, updated_at: 20, turn_count: 3 },
        },
      });
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
  assert.deepEqual(listed[0].summary, {
    title: "First task", createdAt: 10, updatedAt: 20, turnCount: 3,
  });
  assert.equal(Agent.open(agentId, options).id, agentId);
  assert.equal((await Agent.get(agentId, options)).id, agentId);
  assert.equal((await created.state()).latest_event_cursor, "4");
  await created.delete();
  await Agent.delete(agentId, options);

  for (const request of calls) {
    assert.equal(request.credentials, "include");
    assert.equal(request.headers.has("authorization"), false);
  }
  assert.equal(calls.filter((request) =>
    request.method === "GET" && new URL(request.url).pathname === `/v1/agents/${agentId}`
  ).length, 2, "open constructs a handle without adding a state probe");
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

test("managed event history forwards caller cancellation to the fetch boundary", async () => {
  let historySignal;
  const agent = await Agent.create({
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") return Response.json({ agent_id: agentId }, { status: 201 });
      historySignal = request.signal;
      await new Promise((_, reject) => request.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true }));
    },
  });
  const controller = new AbortController();
  const page = agent.events.page({ signal: controller.signal });
  await waitFor(() => historySignal !== undefined);
  controller.abort();

  await assert.rejects(page, { name: "AbortError" });
  assert.equal(historySignal.aborted, true);
});

test("latest event tails adopt the server cursor before reconnecting", async () => {
  const connections = [];
  const requestedCursors = [];
  const agent = await Agent.create({
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST") return Response.json({ agent_id: agentId }, { status: 201 });
      requestedCursors.push(url.searchParams.get("cursor"));
      const connection = controlledEventStream(request.signal, () => {});
      connections.push(connection);
      return connection.response;
    },
  });

  const observed = [];
  const watching = (async () => {
    for await (const event of agent.events.watch({ cursor: "latest" })) {
      observed.push(event.cursor);
      break;
    }
  })();
  await waitFor(() => connections.length === 1);
  connections[0].send("retry: 0\n: cursor 12\n\n");
  connections[0].close();
  await waitFor(() => connections.length === 2);
  connections[1].send(sse("13", "event", eventData("13")));

  await watching;
  assert.deepEqual(requestedCursors, ["latest", "12"]);
  assert.deepEqual(observed, ["13"]);
});

test("latest subscriber joining numeric shared replay starts after an atomic latest boundary", async () => {
  const connections = [];
  const requestedCursors = [];
  const requestSignals = [];
  const agent = await Agent.create({
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST") return Response.json({ agent_id: agentId }, { status: 201 });
      requestedCursors.push(url.searchParams.get("cursor"));
      requestSignals.push(request.signal);
      const connection = controlledEventStream(request.signal, () => {});
      connections.push(connection);
      return connection.response;
    },
  });

  const replayed = [];
  const replaying = (async () => {
    for await (const event of agent.events.watch({ cursor: "0" })) {
      replayed.push(event.cursor);
      if (event.cursor === "101") return;
    }
  })();
  await waitFor(() => connections.length === 1);
  connections[0].send(`${sse("1", "event", eventData("1"))}${sse("2", "event", eventData("2"))}`);
  await waitFor(() => replayed.length === 2);

  const latest = agent.events.watch({ cursor: "latest" });
  const firstLatest = latest.next();
  await waitFor(() => connections.length === 2);
  connections[1].send(": cursor 100\n\n");
  await waitFor(() => requestSignals[1].aborted);
  await new Promise((resolve) => setTimeout(resolve, 0));
  connections[0].send(Array.from(
    { length: 99 },
    (_, index) => sse(String(index + 3), "event", eventData(String(index + 3))),
  ).join(""));

  assert.equal((await firstLatest).value.cursor, "101");
  await latest.return();
  await replaying;
  assert.deepEqual(requestedCursors, ["0", "latest"]);
  assert.deepEqual(replayed, Array.from({ length: 101 }, (_, index) => String(index + 1)));
});

test("browser online recovery replaces a half-open managed event stream from its exact cursor", async () => {
  const online = new EventTarget();
  const addDescriptor = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  const removeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "removeEventListener");
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: online.addEventListener.bind(online),
  });
  Object.defineProperty(globalThis, "removeEventListener", {
    configurable: true,
    value: online.removeEventListener.bind(online),
  });
  try {
    const connections = [];
    const requestedCursors = [];
    const agent = await Agent.create({
      baseUrl: origin,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method === "POST") return Response.json({ agent_id: agentId }, { status: 201 });
        requestedCursors.push(url.searchParams.get("cursor"));
        const connection = controlledEventStream(request.signal, () => {});
        connections.push(connection);
        return connection.response;
      },
    });
    const observed = [];
    const watching = (async () => {
      for await (const event of agent.events.watch({ cursor: "5" })) {
        observed.push(event.cursor);
        if (event.type === "turn_completed") return event;
      }
      throw new Error("managed event stream ended before terminal recovery");
    })();

    await waitFor(() => connections.length === 1);
    connections[0].send(sse("6", "event", eventData("6")));
    await waitFor(() => observed.includes("6"));
    online.dispatchEvent(new Event("online"));
    await waitFor(() => connections.length === 2);
    connections[1].send(sse("7", "turn_completed", {
      cursor: "7",
      created_at: 7,
      turn_id: "turn-online",
      type: "turn_completed",
      id: "turn-online",
      final_message: "recovered online",
      usage: null,
    }));

    assert.equal((await watching).data.final_message, "recovered online");
    assert.deepEqual(requestedCursors, ["5", "6"]);
  } finally {
    if (addDescriptor) Object.defineProperty(globalThis, "addEventListener", addDescriptor);
    else Reflect.deleteProperty(globalThis, "addEventListener");
    if (removeDescriptor) Object.defineProperty(globalThis, "removeEventListener", removeDescriptor);
    else Reflect.deleteProperty(globalThis, "removeEventListener");
  }
});

test("a latest main stream persists its control cursor across browser online recovery", async () => {
  const online = new EventTarget();
  const restoreOnline = installOnlineTarget(online);
  try {
    const connections = [];
    const requestedCursors = [];
    const agent = Agent.open(agentId, {
      baseUrl: origin,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requestedCursors.push(new URL(request.url).searchParams.get("cursor"));
        const connection = controlledEventStream(request.signal, () => {});
        connections.push(connection);
        return connection.response;
      },
    });
    const events = agent.events.watch({ cursor: "latest" });
    const next = events.next();
    await waitFor(() => connections.length === 1);
    connections[0].send(": cursor 44\n\n");
    await new Promise((resolve) => setTimeout(resolve, 0));

    online.dispatchEvent(new Event("online"));
    await waitFor(() => connections.length === 2);
    connections[1].send(sse("45", "event", eventData("45")));
    assert.equal((await next).value.cursor, "45");
    await events.return();
    assert.deepEqual(requestedCursors, ["latest", "44"]);
  } finally {
    restoreOnline();
  }
});

test("logical online retirement replaces a fetch that ignores abort and fences its stale response", async () => {
  const online = new EventTarget();
  const restoreOnline = installOnlineTarget(online);
  try {
    const heldFetch = deferredPromise();
    const connections = [];
    const requestedCursors = [];
    const agent = Agent.open(agentId, {
      baseUrl: origin,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requestedCursors.push(new URL(request.url).searchParams.get("cursor"));
        if (requestedCursors.length === 1) return heldFetch.promise;
        const connection = controlledEventStream(request.signal, () => {});
        connections.push(connection);
        return connection.response;
      },
    });
    const events = agent.events.watch({ cursor: "0" });
    const first = events.next();
    await waitFor(() => requestedCursors.length === 1);
    online.dispatchEvent(new Event("online"));
    await waitFor(() => connections.length === 1);
    connections[0].send(sse("1", "event", eventData("1")));
    assert.equal((await first).value.cursor, "1");

    let stalePublished = false;
    const second = events.next().then((value) => {
      stalePublished = true;
      return value;
    });
    heldFetch.resolve(eventStream([sse("99", "event", eventData("99"))]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stalePublished, false);
    connections[0].send(sse("2", "event", eventData("2")));
    assert.equal((await second).value.cursor, "2");
    await events.return();
    assert.deepEqual(requestedCursors, ["0", "0"]);
  } finally {
    restoreOnline();
  }
});

test("logical online retirement does not await a nonsettling response reader cancellation", async () => {
  const online = new EventTarget();
  const restoreOnline = installOnlineTarget(online);
  try {
    const cancelStarted = deferredPromise();
    const cancelHeld = deferredPromise();
    const connections = [];
    let requests = 0;
    const agent = Agent.open(agentId, {
      baseUrl: origin,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests += 1;
        if (requests === 1) {
          return new Response(new ReadableStream({
            cancel() {
              cancelStarted.resolve();
              return cancelHeld.promise;
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        const connection = controlledEventStream(request.signal, () => {});
        connections.push(connection);
        return connection.response;
      },
    });
    const events = agent.events.watch({ cursor: "0" });
    const next = events.next();
    await waitFor(() => requests === 1);
    online.dispatchEvent(new Event("online"));
    await cancelStarted.promise;
    await waitFor(() => connections.length === 1);
    connections[0].send(sse("1", "event", eventData("1")));
    assert.equal((await next).value.cursor, "1");
    await events.return();
    assert.equal(requests, 2);
  } finally {
    restoreOnline();
  }
});

test("managed event streams reconnect after a response reader fails", async () => {
  const connections = [];
  const requestedCursors = [];
  const agent = await Agent.create({
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST") return Response.json({ agent_id: agentId }, { status: 201 });
      requestedCursors.push(url.searchParams.get("cursor"));
      const connection = controlledEventStream(request.signal, () => {});
      connections.push(connection);
      return connection.response;
    },
  });
  const observed = [];
  const watching = (async () => {
    for await (const event of agent.events.watch({ cursor: "8" })) {
      observed.push(event.cursor);
      if (observed.length === 2) break;
    }
  })();
  await waitFor(() => connections.length === 1);
  connections[0].send(`retry: 0\n\n${sse("9", "event", eventData("9"))}`);
  await waitFor(() => observed.length === 1);
  connections[0].fail(new Error("injected reader failure"));
  await waitFor(() => connections.length === 2);
  connections[1].send(sse("10", "event", eventData("10")));

  await watching;
  assert.deepEqual(observed, ["9", "10"]);
  assert.deepEqual(requestedCursors, ["8", "9"]);
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

test("a result joining a latest tail replays durably from its accepted cursor", async () => {
  const connections = [];
  const requestedCursors = [];
  const requestSignals = [];
  let activeConnections = 0;
  let maximumActiveConnections = 0;
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/turns")) {
      return Response.json({
        turn_id: "turn-latest-result",
        state: "accepted",
        accepted_cursor: "186",
        terminal_cursor: null,
      }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      requestedCursors.push(url.searchParams.get("cursor"));
      requestSignals.push(request.signal);
      activeConnections += 1;
      maximumActiveConnections = Math.max(maximumActiveConnections, activeConnections);
      const connection = controlledEventStream(request.signal, () => { activeConnections -= 1; });
      connections.push(connection);
      return connection.response;
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  const agent = Agent.open(agentId, { baseUrl: origin, fetch });
  const events = agent.events.watch({ cursor: "latest" });
  const watchedAcceptance = events.next();
  await waitFor(() => connections.length === 1);
  connections[0].send(": cursor 185\n\n");

  const turn = agent.turn.prompt({
    id: "turn-latest-result",
    input: "replay my result",
    idempotencyKey: "latest-result-request",
  });
  connections[0].send(sse("186", "turn_accepted", {
    cursor: "186",
    created_at: 1,
    turn_id: "turn-latest-result",
    type: "turn_accepted",
    id: "turn-latest-result",
    input: "replay my result",
  }));
  assert.equal((await within(watchedAcceptance, "latest watcher acceptance")).value.cursor, "186");
  const watchedTerminal = events.next();
  const result = turn.result();

  await waitFor(() => connections.length === 2);
  assert.equal(requestSignals[0].aborted, true);
  connections[1].send(sse("211", "turn_completed", {
    cursor: "211",
    created_at: 2,
    turn_id: "turn-latest-result",
    type: "turn_completed",
    id: "turn-latest-result",
    final_message: "replayed",
    usage: null,
  }));

  assert.deepEqual(await within(result, "latest-tail result replay"), {
    turnId: "turn-latest-result",
    finalMessage: "replayed",
    usage: null,
    cursor: "211",
  });
  assert.equal((await within(watchedTerminal, "latest watcher terminal")).value.cursor, "211");
  await events.return();
  assert.deepEqual(requestedCursors, ["latest", "186"]);
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

test("a result observer can detach without aborting durable prompt or cancel mutations", async () => {
  const connections = [];
  let promptSignal;
  let cancelSignal;
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/turns")) {
      promptSignal = request.signal;
      return Response.json({
        turn_id: "turn-observer",
        state: "accepted",
        accepted_cursor: "5",
        terminal_cursor: null,
      }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      const connection = controlledEventStream(request.signal, () => {});
      connections.push(connection);
      return connection.response;
    }
    if (request.method === "POST" && url.pathname.endsWith("/turn-observer/cancel")) {
      cancelSignal = request.signal;
      return Response.json({ turn_id: "turn-observer", state: "cancelling" }, { status: 202 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const turn = Agent.open(agentId, { baseUrl: origin, fetch }).turn.prompt({
    id: "turn-observer",
    input: "stay durable",
    idempotencyKey: "observer-request",
  });
  const observer = new AbortController();
  const result = turn.result({ signal: observer.signal });
  await waitFor(() => connections.length === 1);
  observer.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(promptSignal.aborted, false);
  await turn.cancel();
  assert.equal(cancelSignal.aborted, false);
});

test("stable-ID cancellation dispatches after the prompt AbortSignal has fired", async () => {
  const promptStarted = deferredPromise();
  let cancelSignal;
  const promptController = new AbortController();
  const turn = Agent.open(agentId, {
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/turns")) {
        promptStarted.resolve();
        await new Promise((_, reject) => request.signal.addEventListener("abort", () => {
          reject(new DOMException("prompt aborted", "AbortError"));
        }, { once: true }));
      }
      if (request.method === "POST" && url.pathname.endsWith("/turn-aborted/cancel")) {
        cancelSignal = request.signal;
        return Response.json({ turn_id: "turn-aborted", state: "cancelling" }, { status: 202 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  }).turn.prompt({
    id: "turn-aborted",
    input: "cancel by stable identity",
    idempotencyKey: "turn-aborted-request",
    signal: promptController.signal,
  });
  await promptStarted.promise;
  promptController.abort();
  await assert.rejects(turn.accepted(), { name: "AbortError" });

  assert.deepEqual(await turn.cancel(), { turn_id: "turn-aborted", state: "cancelling" });
  assert.equal(cancelSignal.aborted, false);
});

test("stable-ID cancellation does not wait for a nonsettling prompt response", async () => {
  const promptStarted = deferredPromise();
  const neverSettles = deferredPromise();
  const requests = [];
  const turn = Agent.open(agentId, {
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" && url.pathname.endsWith("/turns")) {
        promptStarted.resolve();
        await neverSettles.promise;
      }
      if (request.method === "POST" && url.pathname.endsWith("/turn-held/cancel")) {
        return Response.json({ turn_id: "turn-held", state: "cancelling" }, { status: 202 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  }).turn.prompt({
    id: "turn-held",
    input: "the response can be lost after durable acceptance",
    idempotencyKey: "turn-held-request",
  });
  await promptStarted.promise;

  const cancelled = await within(turn.cancel(), 100, "stable-ID cancellation");
  assert.deepEqual(cancelled, { turn_id: "turn-held", state: "cancelling" });
  assert.deepEqual(requests, [
    `POST /v1/agents/${agentId}/turns`,
    `POST /v1/agents/${agentId}/turns/turn-held/cancel`,
  ]);
});

test("paused managed event subscribers fail with a terminal-safe reconnect cursor", async () => {
  const connections = [];
  const requestSignals = [];
  const requestedCursors = [];
  const agent = Agent.open(agentId, {
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requestedCursors.push(new URL(request.url).searchParams.get("cursor"));
      requestSignals.push(request.signal);
      const connection = controlledEventStream(request.signal, () => {});
      connections.push(connection);
      return connection.response;
    },
  });
  const paused = agent.events.watch({ cursor: "0" });
  await waitFor(() => connections.length === 1);
  connections[0].send(Array.from(
    { length: 4_097 },
    (_, index) => sse(String(index + 1), "event", eventData(String(index + 1))),
  ).join(""));
  await waitFor(() => requestSignals[0].aborted);

  for (let cursor = 1; cursor <= 4_096; cursor += 1) {
    assert.equal((await paused.next()).value.cursor, String(cursor));
  }
  await assert.rejects(
    paused.next(),
    (error) => {
      assert(error instanceof ManagedError);
      assert.equal(error.code, "event_backlog_exceeded");
      assert.match(error.message, /reconnect with events\.watch\(\{ cursor: "4096" \}\)/);
      return true;
    },
  );

  const resumed = agent.events.watch({ cursor: "4096" });
  const terminal = resumed.next();
  await waitFor(() => connections.length === 2);
  connections[1].send(sse("4097", "turn_completed", {
    cursor: "4097",
    created_at: 4_097,
    turn_id: "turn-terminal",
    type: "turn_completed",
    id: "turn-terminal",
    final_message: "terminal retained",
    usage: null,
  }));
  assert.equal((await terminal).value.data.final_message, "terminal retained");
  await resumed.return();
  assert.deepEqual(requestedCursors, ["0", "4096"]);
});

test("observer detachment stops waiting for a held submission without aborting it", async () => {
  const submitted = deferredPromise();
  let mutationSignal;
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      mutationSignal = request.signal;
      await submitted.promise;
      return Response.json({
        turn_id: "turn-held-submit",
        state: "accepted",
        accepted_cursor: "5",
        terminal_cursor: null,
      }, { status: 202 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const turn = Agent.open(agentId, { baseUrl: origin, fetch }).turn.prompt({
    id: "turn-held-submit",
    input: "commit independently",
    idempotencyKey: "held-submit-request",
  });
  const observer = new AbortController();
  const result = turn.result({ signal: observer.signal });
  await waitFor(() => mutationSignal !== undefined);
  observer.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(mutationSignal.aborted, false);
  submitted.resolve();
  assert.equal(await turn.accepted(), "turn-held-submit");
});

test("an inactive managed SSE reconnects from the exact cursor", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const requestedCursors = [];
  let connections = 0;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === 45_000 ? 0 : delay,
    ...args,
  );
  try {
    const fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/turns")) {
        return Response.json({
          turn_id: "turn-inactive",
          state: "accepted",
          accepted_cursor: "5",
          terminal_cursor: null,
        }, { status: 202 });
      }
      if (request.method === "GET" && url.pathname.endsWith("/events")) {
        requestedCursors.push(url.searchParams.get("cursor"));
        connections += 1;
        const connection = controlledEventStream(request.signal, () => {});
        if (connections === 1) {
          queueMicrotask(() => connection.send("retry: 0\n\n"));
        } else {
          queueMicrotask(() => connection.send(sse("6", "turn_completed", {
            cursor: "6",
            created_at: 1,
            turn_id: "turn-inactive",
            type: "turn_completed",
            id: "turn-inactive",
            final_message: "reconnected",
            usage: null,
          })));
        }
        return connection.response;
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    const result = await Agent.open(agentId, { baseUrl: origin, fetch }).turn.prompt({
      id: "turn-inactive",
      input: "recover half-open stream",
      idempotencyKey: "inactive-request",
    }).result();
    assert.equal(result.finalMessage, "reconnected");
    assert.deepEqual(requestedCursors, ["5", "5"]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("managed SSE rejects an unterminated decoded frame beyond its byte budget", async () => {
  const connections = [];
  const agent = Agent.open(agentId, {
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const connection = controlledEventStream(request.signal, () => {});
      connections.push(connection);
      return connection.response;
    },
  });
  const events = agent.events.watch({ cursor: "0" });
  const next = events.next();
  await waitFor(() => connections.length === 1);
  connections[0].send(`data: ${"x".repeat(2 * 1024 * 1024)}`);
  await assert.rejects(next, (error) => {
    assert(error instanceof ManagedError);
    assert.equal(error.code, "event_frame_too_large");
    return true;
  });
});

test("managed terminal retention is bounded by encoded bytes as well as turn count", async () => {
  const connections = [];
  const agent = Agent.open(agentId, {
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST") {
        return Response.json({
          turn_id: "turn-cache-0",
          state: "accepted",
          accepted_cursor: "0",
          terminal_cursor: null,
        }, { status: 202 });
      }
      const connection = controlledEventStream(request.signal, () => {});
      connections.push(connection);
      return connection.response;
    },
  });
  let observed = 0;
  const watching = (async () => {
    for await (const _event of agent.events.watch({ cursor: "0" })) {
      observed += 1;
      if (observed === 9) return;
    }
  })();
  await waitFor(() => connections.length === 1);
  for (let index = 0; index < 9; index += 1) {
    const cursor = String(index + 1);
    connections[0].send(sse(cursor, "turn_completed", {
      cursor,
      created_at: index + 1,
      turn_id: `turn-cache-${index}`,
      type: "turn_completed",
      id: `turn-cache-${index}`,
      final_message: `${index}:${"x".repeat(1024 * 1024)}`,
      usage: null,
    }));
    await waitFor(() => observed === index + 1);
  }
  await watching;

  const observer = new AbortController();
  let settled = false;
  const result = agent.turn.prompt({
    id: "turn-cache-0",
    input: "inspect byte-bounded cache",
    idempotencyKey: "turn-cache-request",
  }).result({ signal: observer.signal }).finally(() => { settled = true; });
  await waitFor(() => connections.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, "the oldest large terminal was evicted before the 256-turn count cap");
  observer.abort();
  await assert.rejects(result, { name: "AbortError" });
});

test("the first managed terminal is canonical, identical replay is ignored, and conflict fails", async () => {
  const connections = [];
  const agent = Agent.open(agentId, {
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST") {
        return Response.json({
          turn_id: "turn-canonical",
          state: "accepted",
          accepted_cursor: "0",
          terminal_cursor: null,
        }, { status: 202 });
      }
      const connection = controlledEventStream(request.signal, () => {});
      connections.push(connection);
      return connection.response;
    },
  });
  const events = agent.events.watch({ cursor: "0" });
  const canonical = {
    cursor: "1",
    created_at: 1,
    turn_id: "turn-canonical",
    type: "turn_completed",
    id: "turn-canonical",
    final_message: "first answer",
    usage: null,
  };
  const first = events.next();
  await waitFor(() => connections.length === 1);
  connections[0].send(sse("1", "turn_completed", canonical));
  assert.equal((await first).value.data.final_message, "first answer");

  let replayPublished = false;
  const afterReplay = events.next().then((value) => {
    replayPublished = true;
    return value;
  });
  connections[0].send(sse("1", "turn_completed", canonical));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(replayPublished, false);
  connections[0].send(sse("2", "event", eventData("2")));
  assert.equal((await afterReplay).value.cursor, "2");

  const conflict = events.next();
  connections[0].send(sse("3", "turn_completed", {
    ...canonical,
    cursor: "3",
    created_at: 3,
    final_message: "conflicting answer",
  }));
  await assert.rejects(conflict, (error) => {
    assert(error instanceof ManagedError);
    assert.equal(error.code, "conflicting_terminal");
    return true;
  });

  const result = await agent.turn.prompt({
    id: "turn-canonical",
    input: "read canonical result",
    idempotencyKey: "turn-canonical-request",
  }).result();
  assert.equal(result.finalMessage, "first answer");
  assert.equal(result.cursor, "1");
});

test("browser transport failures become retryable managed errors", async () => {
  await assert.rejects(
    Agent.list({
      baseUrl: origin,
      fetch: async () => { throw new TypeError("Load failed"); },
    }),
    (error) => {
      assert(error instanceof ManagedError);
      assert.equal(error.code, "network_error");
      assert.equal(
        error.message,
        "Managed agent connection was interrupted. Check your network and retry.",
      );
      assert.equal(error.cause.message, "Load failed");
      return true;
    },
  );
});

test("managed prompts retry browser transport failures with one idempotency key", async () => {
  const requests = [];
  const agent = Agent.open(agentId, {
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length < 3) throw new TypeError("Load failed");
      return Response.json({
        turn_id: "turn-1",
        state: "completed",
        accepted_cursor: "1",
        terminal_cursor: "2",
        terminal: {
          type: "turn_completed",
          final_message: "done",
          usage: null,
        },
      });
    },
  });

  const turn = agent.turn.prompt({
    id: "turn-1",
    input: "hello",
    idempotencyKey: "retry-key",
  });
  assert.equal(await turn.accepted(), "turn-1");
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((request) => request.headers.get("idempotency-key")),
    ["retry-key", "retry-key", "retry-key"],
  );
});

test("managed prompts replay a committed turn when its acknowledgement never settles", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const requests = [];
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === 10_000 ? 0 : delay,
    ...args,
  );
  const keepAlive = originalSetTimeout(() => {}, 1_000);
  try {
    const result = await Agent.open(agentId, {
      baseUrl: origin,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (requests.length === 1) {
          await new Promise((_, reject) => request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          ));
        }
        return Response.json({
          turn_id: "turn-committed",
          state: "completed",
          accepted_cursor: "1",
          terminal_cursor: "2",
          terminal: {
            type: "turn_completed",
            final_message: "recovered",
            usage: null,
          },
        }, { status: 202 });
      },
    }).turn.prompt({
      id: "turn-committed",
      input: "survive a lost acknowledgement",
      idempotencyKey: "committed-request",
    }).result();

    assert.equal(result.finalMessage, "recovered");
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.headers.get("idempotency-key")),
      ["committed-request", "committed-request"],
    );
    assert.equal(await requests[0].text(), await requests[1].text());
  } finally {
    clearTimeout(keepAlive);
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("managed results recover a retained terminal from authoritative turn state", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const connections = [];
  let stateReads = 0;
  let closedConnections = 0;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === 1_000 ? 0 : delay,
    ...args,
  );
  try {
    const agent = Agent.open(agentId, {
      baseUrl: origin,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname.endsWith("/turns")) {
          return Response.json({
            turn_id: "turn-state-recovery",
            state: "accepted",
            accepted_cursor: "1",
            terminal_cursor: null,
          }, { status: 202 });
        }
        if (request.method === "GET" && url.pathname.endsWith("/events")) {
          const connection = controlledEventStream(request.signal, () => { closedConnections += 1; });
          connections.push(connection);
          return connection.response;
        }
        if (request.method === "GET" && url.pathname.endsWith("/turns/turn-state-recovery")) {
          stateReads += 1;
          return Response.json({
            turn_id: "turn-state-recovery",
            state: "completed",
            accepted_cursor: "1",
            terminal_cursor: "2",
            terminal: {
              type: "turn_completed",
              final_message: "recovered from durable state",
              usage: null,
            },
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });

    const result = await agent.turn.prompt({
      id: "turn-state-recovery",
      input: "recover me",
      idempotencyKey: "state-recovery-request",
    }).result();

    assert.equal(result.finalMessage, "recovered from durable state");
    assert.equal(stateReads, 1);
    await waitFor(() => connections.length === 1 && closedConnections === 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
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
    fail(error) {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", finish);
      onClose();
      controller.error(error);
    },
  };
}

function deferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => { resolve = next; reject = fail; });
  return { promise, reject, resolve };
}

function installOnlineTarget(target) {
  const addDescriptor = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  const removeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "removeEventListener");
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: target.addEventListener.bind(target),
  });
  Object.defineProperty(globalThis, "removeEventListener", {
    configurable: true,
    value: target.removeEventListener.bind(target),
  });
  return () => {
    if (addDescriptor) Object.defineProperty(globalThis, "addEventListener", addDescriptor);
    else Reflect.deleteProperty(globalThis, "addEventListener");
    if (removeDescriptor) Object.defineProperty(globalThis, "removeEventListener", removeDescriptor);
    else Reflect.deleteProperty(globalThis, "removeEventListener");
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for managed event state");
}

async function within(promise, milliseconds, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function sse(id, event, data) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
