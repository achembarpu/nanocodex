import { env, SELF as RAW_SELF, evictDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NanocodexSession, type Env } from "../src/index";

const testEnv = env as unknown as Env;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY = `ncx_live_${"k".repeat(12)}_${"s".repeat(43)}`;
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_API_KEY = `ncx_live_${"o".repeat(12)}_${"p".repeat(43)}`;
const createdAgents = new Set<string>();
const SELF = { fetch: managedFetch };

beforeAll(async () => {
  await seedApiKey(USER_ID, API_KEY);
  await seedApiKey(OTHER_USER_ID, OTHER_API_KEY);
});

afterEach(async () => {
  await Promise.all([...createdAgents].map(async (id) => {
    await SELF.fetch(`https://example.test/v1/agents/${id}`, { method: "DELETE" });
    createdAgents.delete(id);
  }));
});

describe("managed agents REST and resumable SSE", () => {
  it("bootstraps one browser identity and binds passkey options to it", async () => {
    const first = await RAW_SELF.fetch("https://example.test/v1/me");
    expect(first.status).toBe(200);
    const cookie = first.headers.get("set-cookie");
    expect(cookie).toMatch(/^nanocodex_account=a_[A-Za-z0-9_-]{43};/);
    const account = await first.json<{
      user: { id: string; persistent: boolean };
      authentication: string;
    }>();
    expect(account).toMatchObject({
      user: { persistent: false },
      authentication: "account_session",
    });

    const cookieHeader = cookie!.split(";", 1)[0]!;
    const repeated = await RAW_SELF.fetch("https://example.test/v1/me", {
      headers: { cookie: cookieHeader },
    });
    expect((await repeated.json<{ user: { id: string } }>()).user.id).toBe(account.user.id);
    expect(repeated.headers.get("set-cookie")).toBeNull();

    const options = await RAW_SELF.fetch("https://example.test/webauthn/register/options", {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/json",
        origin: "https://example.test",
      },
      body: JSON.stringify({ name: "attacker", userId: crypto.randomUUID() }),
    });
    expect(options.status).toBe(200);
    const creation = await options.json<{ options: { publicKey?: { user: { id: string } } } }>();
    const encodedUserId = creation.options.publicKey?.user.id;
    expect(encodedUserId).toBeTruthy();
    const base64UserId = encodedUserId!.replaceAll("-", "+").replaceAll("_", "/");
    const decodedUserId = new TextDecoder().decode(
      Uint8Array.from(atob(base64UserId.padEnd(Math.ceil(base64UserId.length / 4) * 4, "=")),
        (character) => character.charCodeAt(0)),
    );
    expect(decodedUserId).toBe(account.user.id);
  });

  it("recognizes passkey sessions even when their random token begins with the anonymous prefix", async () => {
    const tokens = ["w".repeat(43), `a_${"w".repeat(41)}`];
    for (const [index, token] of tokens.entries()) {
      const userId = `22222222-2222-4222-8222-22222222222${index}`;
      await seedPasskeySession(userId, token);
      const response = await RAW_SELF.fetch("https://example.test/v1/me", {
        headers: { cookie: `nanocodex_account=${token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        user: { id: userId, persistent: true },
        authentication: "account_session",
      });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("forwards a browser account search body exactly once without leaking its credential", async () => {
    const session = await RAW_SELF.fetch("https://example.test/v1/me");
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    const account = await session.json<{ user: { id: string } }>();
    expect(cookie).toMatch(/^nanocodex_account=a_[A-Za-z0-9_-]{43}$/);

    const body = '{\n  "id": "browser-search",\n  "commands": { "search_query": [{ "q": "Rust 🦀" }] }\n}';
    const response = await RAW_SELF.fetch("https://nanocodex.internal/v1/search", {
      method: "POST",
      headers: {
        authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
        cookie: cookie!,
        "content-type": "application/json",
        origin: "https://example.test",
        "x-nanocodex-subject": "browser-controlled-subject",
      },
      body,
    });

    expect(response.status).toBe(200);
    const forwarded = await response.json<{
      body: string;
      cookie: string | null;
      origin: string | null;
      subject: string;
    }>();
    expect(forwarded).toMatchObject({
      body,
      cookie: null,
      origin: "https://example.test",
    });
    expect(forwarded.subject).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(forwarded.subject).not.toBe("browser-controlled-subject");
    expect(JSON.stringify(forwarded)).not.toContain(cookie!);
    expect(JSON.stringify(forwarded)).not.toContain(account.user.id);
  });

  it("lets anonymous and passkey cookies use browser-local and managed-durable runtimes", async () => {
    const anonymous = await RAW_SELF.fetch("https://example.test/v1/me");
    const anonymousCookie = anonymous.headers.get("set-cookie")?.split(";", 1)[0];
    expect(anonymousCookie).toMatch(/^nanocodex_account=a_[A-Za-z0-9_-]{43}$/);

    const passkeyUserId = "44444444-4444-4444-8444-444444444444";
    const passkeyToken = `a_${"z".repeat(41)}`;
    await seedPasskeySession(passkeyUserId, passkeyToken);
    const principals = [
      { kind: "anonymous", cookie: anonymousCookie! },
      { kind: "passkey", cookie: `nanocodex_account=${passkeyToken}` },
    ];

    for (const principal of principals) {
      const search = await RAW_SELF.fetch("https://nanocodex.internal/v1/search", {
        method: "POST",
        headers: {
          authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
          cookie: principal.cookie,
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify({ mode: principal.kind }),
      });
      expect(search.status).toBe(200);
      expect(await search.json()).toMatchObject({
        body: JSON.stringify({ mode: principal.kind }),
        cookie: null,
        origin: "https://example.test",
      });

      const created = await RAW_SELF.fetch("https://example.test/v1/agents", {
        method: "POST",
        headers: { cookie: principal.cookie, origin: "https://example.test" },
      });
      expect(created.status).toBe(201);
      const receipt = await created.json<AgentReceipt>();
      const listed = await RAW_SELF.fetch("https://example.test/v1/agents", {
        headers: { cookie: principal.cookie },
      });
      expect(await listed.json()).toEqual({ data: [receipt.agent_id] });
      const replay = await RAW_SELF.fetch(receipt.events_url.replace(/\/events$/, ""), {
        headers: { cookie: principal.cookie },
      });
      expect(replay.status).toBe(200);
      await replay.body?.cancel();
      const deleted = await RAW_SELF.fetch(receipt.events_url.replace(/\/events$/, ""), {
        method: "DELETE",
        headers: { cookie: principal.cookie, origin: "https://example.test" },
      });
      expect(deleted.status).toBe(204);
    }
  });

  it("runs the default network tools inside a managed durable agent", async () => {
    const agent = await createAgent();
    const accepted = await submit(agent, "turn-managed-web", "E2E_MANAGED_WEB");
    const events = sseReader(await SELF.fetch(
      `${agent.events_url}?cursor=${accepted.accepted_cursor}`,
    ));
    let event;
    do {
      event = await nextWithin(events, "managed web tool completion");
    } while (event.data.type !== "turn_completed");
    expect(event.data).toMatchObject({
      id: "turn-managed-web",
      final_message: "MANAGED_WEB_OK",
      type: "turn_completed",
    });
    await events.cancel();
  });

  it("does not let an unrelated bearer mint managed agents", async () => {
    const response = await RAW_SELF.fetch("https://example.test/v1/agents", {
      method: "POST",
      headers: {
        authorization: `Bearer ncx_live_${"x".repeat(12)}_${"y".repeat(43)}`,
      },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("requires the account API key in addition to the routing UUID", async () => {
    const agent = await createAgent();
    const stateUrl = agent.events_url.replace(/\/events$/, "");
    const missing = await RAW_SELF.fetch(stateUrl);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });
    const wrong = await RAW_SELF.fetch(stateUrl, { headers: {
      authorization: `Bearer ncx_live_${"x".repeat(12)}_${"y".repeat(43)}`,
    } });
    expect(wrong.status).toBe(401);
    expect((await SELF.fetch(stateUrl)).status).toBe(200);
  });

  it("forwards one owner-asserted session request and overwrites caller assertions", async () => {
    const agent = await createAgent();
    const stateUrl = agent.events_url.replace(/\/events$/, "");
    const originalFetch = NanocodexSession.prototype.fetch;
    const forwarded: Array<{ owner: string | null; path: string }> = [];
    const fetchSpy = vi.spyOn(NanocodexSession.prototype, "fetch").mockImplementation(
      async function (this: NanocodexSession, request: Request): Promise<Response> {
        forwarded.push({
          owner: request.headers.get("x-nanocodex-owner-id"),
          path: new URL(request.url).pathname,
        });
        return originalFetch.call(this, request);
      },
    );
    try {
      const owner = await SELF.fetch(stateUrl, {
        headers: { "x-nanocodex-owner-id": OTHER_USER_ID },
      });
      expect(owner.status).toBe(200);
      expect(forwarded).toEqual([{ owner: USER_ID, path: "/state" }]);

      forwarded.length = 0;
      const other = await RAW_SELF.fetch(stateUrl, {
        headers: {
          authorization: `Bearer ${OTHER_API_KEY}`,
          "x-nanocodex-owner-id": USER_ID,
        },
      });
      expect(other.status).toBe(404);
      expect(await other.json()).toEqual({ error: "not_found" });
      expect(forwarded).toEqual([{ owner: OTHER_USER_ID, path: "/state" }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("starts credential binding and session initialization before either settles", async () => {
    const originalBroker = testEnv.NANOCODEX;
    const originalSessions = testEnv.NANOCODEX_SESSIONS;
    const started = new Set<"binding" | "initialization">();
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const markStarted = async (operation: "binding" | "initialization") => {
      started.add(operation);
      if (started.size === 2) release();
      await bothStarted;
    };
    testEnv.NANOCODEX = {
      async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const request = new Request(input, init);
        if (request.method === "PUT" && new URL(request.url).pathname.startsWith("/subjects/")) {
          await markStarted("binding");
        }
        return originalBroker.fetch(input, init);
      },
    } as Fetcher;
    testEnv.NANOCODEX_SESSIONS = {
      idFromName(name: string) {
        return originalSessions.idFromName(name);
      },
      getByName(name: string) {
        const session = originalSessions.getByName(name);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const request = new Request(input, init);
            if (request.method === "PUT" && new URL(request.url).pathname === "/initialize") {
              await markStarted("initialization");
            }
            return session.fetch(input, init);
          },
        } as DurableObjectStub;
      },
    } as Env["NANOCODEX_SESSIONS"];

    try {
      const response = await SELF.fetch("https://example.test/v1/agents", { method: "POST" });
      expect(response.status).toBe(201);
      const receipt = await response.json<AgentReceipt>();
      createdAgents.add(receipt.agent_id);
      expect(started).toEqual(new Set(["binding", "initialization"]));
    } finally {
      testEnv.NANOCODEX = originalBroker;
      testEnv.NANOCODEX_SESSIONS = originalSessions;
    }
  });

  it("lists only the current user's agents and hides them from other users", async () => {
    const agent = await createAgent();
    const mine = await SELF.fetch("https://example.test/v1/agents");
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ data: [agent.agent_id] });

    const other = await RAW_SELF.fetch(agent.events_url.replace(/\/events$/, ""), {
      headers: { authorization: `Bearer ${OTHER_API_KEY}` },
    });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "not_found" });

    const otherList = await RAW_SELF.fetch("https://example.test/v1/agents", {
      headers: { authorization: `Bearer ${OTHER_API_KEY}` },
    });
    expect(await otherList.json()).toEqual({ data: [] });
  });

  it("requires stable identifiers and strictly validates structured prompt content", async () => {
    const agent = await createAgent();
    const turnsUrl = agent.events_url.replace(/\/events$/, "/turns");
    const missingIdentifier = await SELF.fetch(turnsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(missingIdentifier.status).toBe(400);
    expect(await missingIdentifier.json()).toMatchObject({ error: "idempotency_required" });

    const invalidInputs: unknown[] = [
      " ",
      [],
      [{ type: "text", text: "hello", extra: true }],
      [{ type: "image", image_url: "https://example.test/image.png", detail: "huge" }],
      [{ type: "audio" }],
      [{ type: "video", video_url: "https://example.test/video.mp4" }],
    ];
    for (const [index, input] of invalidInputs.entries()) {
      const response = await SELF.fetch(turnsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: `invalid-${index}`, input }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: index === 0 ? "empty_prompt" : "invalid_prompt",
      });
    }
  });

  it("atomically accepts turns and binds idempotency keys to normalized input", async () => {
    const agent = await createAgent();
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "incoming-request-7",
      },
      body: JSON.stringify({ id: "turn-7", input: "write hello.txt" }),
    } satisfies RequestInit;

    const accepted = await SELF.fetch(`${agent.events_url.replace(/\/events$/, "/turns")}`, request);
    expect(accepted.status).toBe(202);
    const first = await accepted.json<ManagedTurnView>();
    expect(first).toMatchObject({
      turn_id: "turn-7",
      state: "accepted",
      input: "write hello.txt",
      terminal_cursor: null,
    });
    expect(BigInt(first.accepted_cursor)).toBeGreaterThan(0n);

    const replay = await SELF.fetch(`${agent.events_url.replace(/\/events$/, "/turns")}`, request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      turn_id: "turn-7",
      accepted_cursor: first.accepted_cursor,
    });

    const conflict = await SELF.fetch(agent.events_url.replace(/\/events$/, "/turns"), {
      ...request,
      body: JSON.stringify({ id: "turn-7", input: "different input" }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "idempotency_conflict" });

    const state = await SELF.fetch(
      agent.events_url.replace(/\/events$/, "/turns/turn-7"),
    );
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      turn_id: "turn-7",
      input: "write hello.txt",
      accepted_cursor: first.accepted_cursor,
    });
  });

  it("does not allow a turn id or idempotency key to be aliased", async () => {
    const agent = await createAgent();
    const turnsUrl = agent.events_url.replace(/\/events$/, "/turns");
    const firstRequest = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "stable-key",
      },
      body: JSON.stringify({ id: "stable-turn", input: "hello" }),
    } satisfies RequestInit;
    expect((await SELF.fetch(turnsUrl, firstRequest)).status).toBe(202);

    const changedKey = await SELF.fetch(turnsUrl, {
      ...firstRequest,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "different-key",
      },
    });
    expect(changedKey.status).toBe(409);
    expect(await changedKey.json()).toMatchObject({ error: "idempotency_conflict" });

    const changedId = await SELF.fetch(turnsUrl, {
      ...firstRequest,
      body: JSON.stringify({ id: "different-turn", input: "hello" }),
    });
    expect(changedId.status).toBe(409);
    expect(await changedId.json()).toMatchObject({ error: "idempotency_conflict" });

    const generated = await SELF.fetch(turnsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "generated-turn-key",
      },
      body: JSON.stringify({ input: "generated id" }),
    });
    expect(generated.status).toBe(202);
    const generatedTurn = await generated.json<ManagedTurnView>();
    const replay = await SELF.fetch(turnsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "generated-turn-key",
      },
      body: JSON.stringify({ input: "generated id" }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ turn_id: generatedTurn.turn_id });
  });

  it("persists cancellation intent and its resumable event before acknowledging", async () => {
    const agent = await createAgent();
    const accepted = await submit(agent, "turn-cancel", "wait for cancellation");
    const events = sseReader(await SELF.fetch(`${agent.events_url}?cursor=${accepted.accepted_cursor}`));

    const cancelled = await SELF.fetch(
      agent.events_url.replace(/\/events$/, "/turns/turn-cancel/cancel"),
      { method: "POST" },
    );
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toEqual({ turn_id: "turn-cancel", state: "cancelling" });

    let event;
    do {
      event = await nextWithin(events, "durable cancellation intent");
    } while (event.data.type !== "turn_cancelling");
    expect(event).toMatchObject({
      id: event.data.cursor,
      event: "turn_cancelling",
      data: { id: "turn-cancel", turn_id: "turn-cancel", type: "turn_cancelling" },
    });
    await events.cancel();

    const state = await SELF.fetch(
      agent.events_url.replace(/\/events$/, "/turns/turn-cancel"),
    );
    expect(state.status).toBe(200);
    expect(["cancelling", "cancelled"]).toContain(
      (await state.json<ManagedTurnView>()).state,
    );
  });

  it("uses Last-Event-ID before the query cursor and rejects cursors ahead of storage", async () => {
    const agent = await createAgent();
    await submit(agent, "turn-a", "alpha");

    const response = await SELF.fetch(`${agent.events_url}?cursor=not-a-cursor`, {
      headers: { "last-event-id": "0" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const stream = sseReader(response);
    let accepted;
    do {
      accepted = await nextWithin(stream, "turn acceptance");
    } while (accepted.data.type !== "turn_accepted");
    expect(accepted).toMatchObject({
      id: accepted.data.cursor,
      event: "turn_accepted",
      data: { id: "turn-a", type: "turn_accepted" },
    });
    await stream.cancel();

    const invalid = await SELF.fetch(`${agent.events_url}?cursor=-1`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_cursor" });

    const ahead = await SELF.fetch(`${agent.events_url}?cursor=9223372036854775807`);
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toMatchObject({ error: "cursor_ahead" });
  });

  it("persists cursors across eviction and tails strictly after the acknowledged cursor", async () => {
    const agent = await createAgent();
    const id = new URL(agent.events_url).pathname.split("/").at(-2)!;
    await within(
      evictDurableObject(testEnv.NANOCODEX_SESSIONS.getByName(id)),
      "durable object eviction",
    );

    const replay = sseReader(await SELF.fetch(`${agent.events_url}?cursor=0`));
    const restored = await nextWithin(replay, "post-eviction replay");
    expect(restored.data).toMatchObject({
      agent_id: agent.agent_id,
      cursor: restored.id,
      type: "agent_created",
    });
    await replay.cancel();

    const resumed = sseReader(await SELF.fetch(`${agent.events_url}?cursor=not-used`, {
      headers: { "last-event-id": restored.id },
    }));
    const first = await submit(agent, "turn-one", "one");
    let previous = BigInt(restored.id);
    let next;
    do {
      next = await nextWithin(resumed, "live tail");
      expect(BigInt(next.id)).toBeGreaterThan(previous);
      previous = BigInt(next.id);
    } while (next.data.type !== "turn_accepted" || next.data.id !== "turn-one");
    expect(next.id).toBe(first.accepted_cursor);
    await resumed.cancel();
  });

  it("replays multi-digit cursors in numeric rather than lexical order", async () => {
    const agent = await createAgent();
    await submit(agent, "ordered-turn", "produce a complete event lifecycle");
    const agentUrl = agent.events_url.replace(/\/events$/, "");
    let latest = 0n;
    for (let attempt = 0; attempt < 80 && latest < 12n; attempt += 1) {
      const state = await (await SELF.fetch(agentUrl)).json<{ latest_event_cursor: string }>();
      latest = BigInt(state.latest_event_cursor);
      if (latest < 12n) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(latest).toBeGreaterThanOrEqual(12n);

    const replay = sseReader(await SELF.fetch(`${agent.events_url}?cursor=0`));
    let previous = 0n;
    while (previous < latest) {
      const event = await nextWithin(replay, "numeric cursor replay");
      const cursor = BigInt(event.id);
      expect(cursor).toBeGreaterThan(previous);
      previous = cursor;
    }
    await replay.cancel();
  });

  it("pages a bounded recent event window and then strictly older history", async () => {
    const agent = await createAgent();
    for (let index = 0; index < 4; index += 1) {
      await submit(agent, `history-${index}`, `history prompt ${index}`);
    }

    const recentResponse = await SELF.fetch(`${agent.events_url}/history?limit=2`);
    expect(recentResponse.status).toBe(200);
    expect(recentResponse.headers.get("cache-control")).toContain("no-store");
    const recent = await recentResponse.json<{
      data: Array<{ cursor: string }>;
      has_more: boolean;
      latest_cursor: string;
    }>();
    expect(recent.data).toHaveLength(2);
    expect(recent.has_more).toBe(true);
    expect(recent.data.map((event) => BigInt(event.cursor))).toEqual(
      [...recent.data].map((event) => BigInt(event.cursor)).sort((a, b) => a < b ? -1 : 1),
    );
    expect(recent.latest_cursor).toBe(recent.data.at(-1)?.cursor);

    const before = recent.data[0]!.cursor;
    const older = await (await SELF.fetch(
      `${agent.events_url}/history?before=${before}&limit=2`,
    )).json<{ data: Array<{ cursor: string }> }>();
    expect(older.data).toHaveLength(2);
    expect(older.data.every((event) => BigInt(event.cursor) < BigInt(before))).toBe(true);
    expect(new Set([...older.data, ...recent.data].map((event) => event.cursor)).size).toBe(4);

    expect((await SELF.fetch(`${agent.events_url}/history?before=0&limit=2`)).status).toBe(400);
    expect((await SELF.fetch(`${agent.events_url}/history?limit=257`)).status).toBe(400);
  });

  it("bounds request bodies and clears managed state on deletion", async () => {
    const agent = await createAgent();
    const turnsUrl = agent.events_url.replace(/\/events$/, "/turns");
    expect((await SELF.fetch(turnsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })).status).toBe(400);
    expect((await SELF.fetch(turnsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(1024 * 1024 + 1),
      },
      body: "{}",
    })).status).toBe(413);

    await submit(agent, "turn-delete", "delete me");
    const id = new URL(agent.events_url).pathname.split("/").at(-2)!;
    const deleted = await SELF.fetch(`https://example.test/v1/agents/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    createdAgents.delete(id);
    expect((await SELF.fetch(`https://example.test/v1/agents/${id}`)).status).toBe(404);
    expect((await SELF.fetch(agent.events_url)).status).toBe(404);
  });

  it("bounds concurrent resumable event subscribers", async () => {
    const agent = await createAgent();
    const responses: Response[] = [];
    try {
      for (let index = 0; index < 32; index += 1) {
        const response = await SELF.fetch(`${agent.events_url}?cursor=0`);
        expect(response.status).toBe(200);
        responses.push(response);
      }
      const rejected = await SELF.fetch(`${agent.events_url}?cursor=0`);
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("retry-after")).toBe("1");
      expect(await rejected.json()).toEqual({ error: "event_stream_limit", limit: 32 });
    } finally {
      await Promise.all(responses.map((response) => response.body?.cancel()));
    }
  });
});

type AgentReceipt = {
  agent_id: string;
  events_url: string;
  websocket_url: string;
};

type ManagedTurnView = {
  accepted_cursor: string;
  input: unknown;
  state: string;
  terminal_cursor: string | null;
  turn_id: string;
};

async function createAgent(): Promise<AgentReceipt> {
  const response = await SELF.fetch("https://example.test/v1/agents", {
    method: "POST",
  });
  expect(response.status).toBe(201);
  const receipt = await response.json<AgentReceipt>();
  createdAgents.add(receipt.agent_id);
  return receipt;
}

async function managedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${API_KEY}`);
  return RAW_SELF.fetch(new Request(request, { headers }));
}

async function seedApiKey(userId: string, token: string): Promise<void> {
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  let binary = "";
  for (const byte of digestBytes) binary += String.fromCharCode(byte);
  const digest = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const account = testEnv.NANOCODEX_USERS.getByName(userId);
  const provisioned = await account.fetch("https://user.internal/account", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: userId, persistent: true }),
  });
  expect(provisioned.ok).toBe(true);
  const key = testEnv.NANOCODEX_API_KEYS.getByName(digest);
  await key.fetch("https://api-key.internal/record", { method: "DELETE" });
  const record = await key.fetch(
    "https://api-key.internal/record",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: token.match(/^ncx_live_([A-Za-z0-9_-]{12})_/)?.[1],
        label: "test",
        prefix: token.slice(0, "ncx_live_".length + 12),
        createdAt: Date.now(),
        digest,
        userId,
      }),
    },
  );
  expect(record.status).toBe(201);
}

async function seedPasskeySession(userId: string, token: string): Promise<void> {
  const account = testEnv.NANOCODEX_USERS.getByName(userId);
  const provisioned = await account.fetch("https://user.internal/account", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: userId, persistent: true }),
  });
  expect(provisioned.ok).toBe(true);

  const encodedUserId = btoa(userId).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1_000);
  const auth = testEnv.NANOCODEX_AUTH.getByName("webauthn");
  const stored = await auth.fetch(
    `https://do.invalid/set?key=${encodeURIComponent(`session:${token}`)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: {
          credentialId: `credential-${token}`,
          publicKey: "0x01",
          userId: encodedUserId,
          issuedAt: now,
          expiresAt: now + 60,
        },
        ttl: 60,
      }),
    },
  );
  expect(stored.ok).toBe(true);
}

async function submit(agent: AgentReceipt, id: string, input: string): Promise<ManagedTurnView> {
  const response = await SELF.fetch(agent.events_url.replace(/\/events$/, "/turns"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `request-${id}`,
    },
    body: JSON.stringify({ id, input }),
  });
  expect(response.status).toBe(202);
  return response.json<ManagedTurnView>();
}

function sseReader(response: Response) {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async next(): Promise<{ id: string; event: string; data: Record<string, unknown> }> {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseFrame(frame);
          if (parsed) return parsed;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE stream ended before the next event");
        buffer += chunk.value;
      }
    },
    cancel: () => reader.cancel(),
  };
}

async function nextWithin(
  reader: ReturnType<typeof sseReader>,
  stage: string,
): Promise<{ id: string; event: string; data: Record<string, unknown> }> {
  return within(reader.next(), stage);
}

async function within<Result>(promise: Promise<Result>, stage: string): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${stage}`)), 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parseSseFrame(frame: string) {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (id === undefined || event === undefined || data.length === 0) return undefined;
  return { id, event, data: JSON.parse(data.join("\n")) as Record<string, unknown> };
}
