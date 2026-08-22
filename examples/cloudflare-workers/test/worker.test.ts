import { env } from "cloudflare:workers";
import { evictDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/index";

const authorization = { authorization: "Bearer test-admin-token" };
const workerEnv = env as unknown as Env;

describe("Nanocodex Durable Object Worker", () => {
  it("serves a thin resumable browser client without model credentials", async () => {
    const page = await SELF.fetch("https://example.test/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self' ws: wss:");
    const html = await page.text();
    expect(html).toContain("Durable agent, disposable client.");
    expect(html).toContain("Paste the deployment admin token");

    const script = await SELF.fetch("https://example.test/app.js");
    const source = await script.text();
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(source).toContain("localStorage");
    expect(source).toContain("crypto.randomUUID()");
    expect(source).toContain('window.addEventListener("storage"');
    expect(source).toContain('kind === "assistant.delta"');
    expect(source).toContain("message.active_turn_details");
    expect(source).toContain("session creation token rejected");
    expect(source).not.toContain("OPENAI_API_KEY");
    expect(source).not.toContain("CHATGPT_ACCESS_TOKEN");
  });

  it("protects creation and keeps session state across eviction", async () => {
    const denied = await SELF.fetch("https://example.test/sessions", { method: "POST" });
    expect(denied.status).toBe(401);

    const created = await createSession();
    expect(created.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(created.websocket_url).toBe(`wss://example.test/sessions/${created.session_id}/ws`);

    expect((await SELF.fetch(`https://example.test/sessions/${created.session_id}`)).status).toBe(401);
    const before = await SELF.fetch(`https://example.test/sessions/${created.session_id}`, {
      headers: sessionHeaders(created),
    });
    expect(await before.json()).toMatchObject({
      session_id: created.session_id,
      has_snapshot: false,
      completed_turns: 0,
      agent_loaded: false,
    });

    const stub = workerEnv.NANOCODEX_SESSIONS.getByName(created.session_id);
    await evictDurableObject(stub);

    const after = await SELF.fetch(`https://example.test/sessions/${created.session_id}`, {
      headers: sessionHeaders(created),
    });
    expect(await after.json()).toMatchObject({
      session_id: created.session_id,
      has_snapshot: false,
      completed_turns: 0,
      agent_loaded: false,
    });
  });

  it("hibernates client sockets and validates the bounded protocol without loading WASM", async () => {
    const created = await createSession();
    const response = await SELF.fetch(created.websocket_url.replace("wss:", "https:"), {
      headers: sessionHeaders(created, { Upgrade: "websocket" }),
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    expect(await nextMessage(socket)).toMatchObject({
      type: "ready",
      session_id: created.session_id,
      restored: false,
      active_turns: [],
    });
    socket.send(JSON.stringify({ type: "ping", nonce: "one" }));
    expect(await nextMessage(socket)).toEqual({ type: "pong", nonce: "one" });

    const stub = workerEnv.NANOCODEX_SESSIONS.getByName(created.session_id);
    await evictDurableObject(stub);
    socket.send(JSON.stringify({ type: "status" }));
    expect(await nextMessage(socket)).toMatchObject({
      type: "status",
      active_turns: [],
      agent_loaded: false,
      connected_clients: 1,
    });

    socket.send("not-json");
    expect(await nextMessage(socket)).toMatchObject({ type: "error", code: "invalid_json" });
    socket.send(JSON.stringify({ type: "cancel", id: "missing" }));
    expect(await nextMessage(socket)).toMatchObject({ type: "error", code: "turn_not_found" });
    socket.close(1000, "done");
  });

  it("rejects invalid routes and deletes only the named session", async () => {
    expect((await SELF.fetch("https://example.test/sessions/not-a-session")).status).toBe(404);
    expect((await SELF.fetch("https://example.test/sandbox-preview/not-a-session/8080/")).status).toBe(404);
    const created = await createSession();
    expect((await SELF.fetch(
      `https://example.test/sandbox-preview/${created.session_id}/80/`,
    )).status).toBe(404);
    const deleted = await SELF.fetch(`https://example.test/sessions/${created.session_id}`, {
      method: "DELETE",
      headers: sessionHeaders(created),
    });
    expect(deleted.status).toBe(204);
    expect((await SELF.fetch(`https://example.test/sessions/${created.session_id}`, {
      headers: sessionHeaders(created),
    })).status).toBe(404);
  });

  it("bounds connection amplification and rejects binary and oversized frames", async () => {
    const created = await createSession();
    const sockets: WebSocket[] = [];
    try {
      for (let index = 0; index < 64; index += 1) {
        const response = await SELF.fetch(created.websocket_url.replace("wss:", "https:"), {
          headers: sessionHeaders(created, { Upgrade: "websocket" }),
        });
        expect(response.status).toBe(101);
        const socket = response.webSocket!;
        socket.accept();
        await nextMessage(socket);
        sockets.push(socket);
      }
      const overflow = await SELF.fetch(created.websocket_url.replace("wss:", "https:"), {
        headers: sessionHeaders(created, { Upgrade: "websocket" }),
      });
      expect(overflow.status).toBe(429);

      sockets[0]!.send(new Uint8Array([1, 2, 3]).buffer);
      expect(await nextMessage(sockets[0]!)).toMatchObject({
        type: "error",
        code: "binary_unsupported",
      });

      const closed = nextClose(sockets[1]!);
      sockets[1]!.send("x".repeat(1024 * 1024 + 1));
      expect(await closed).toMatchObject({ code: 1009 });
    } finally {
      for (const socket of sockets) socket.close(1000, "test complete");
    }
  });
});

type SessionReceipt = {
  agent_token: string;
  session_id: string;
  websocket_url: string;
};

async function createSession(): Promise<SessionReceipt> {
  const response = await SELF.fetch("https://example.test/sessions", {
    method: "POST",
    headers: authorization,
  });
  expect(response.status).toBe(201);
  const receipt = await response.json<SessionReceipt>();
  expect(receipt.agent_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(receipt.agent_token).not.toBe(receipt.session_id);
  return receipt;
}

function sessionHeaders(
  session: SessionReceipt,
  initial?: HeadersInit,
): Headers {
  const headers = new Headers(initial);
  headers.set("authorization", `Bearer ${session.agent_token}`);
  return headers;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    }, { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}
