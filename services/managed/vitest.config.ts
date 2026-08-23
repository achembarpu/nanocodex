import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_BROKER = `
const subjects = new Set();
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const subjectRoute = url.pathname.match(/^\\/subjects\\/([A-Za-z0-9_-]{43,128})$/);
    if (subjectRoute && request.method === "PUT") {
      const body = await request.json();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body?.user_id ?? "")) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      subjects.add(subjectRoute[1]);
      return new Response(null, { status: 204 });
    }
    if (subjectRoute && request.method === "DELETE") {
      subjects.delete(subjectRoute[1]);
      return new Response(null, { status: 204 });
    }
    const authorization = request.headers.get("authorization");
    const subject = request.headers.get("x-nanocodex-subject");
    const search = url.href === "https://nanocodex.internal/v1/search"
      && request.method === "POST"
      && authorization === "Bearer NANOCODEX_PROVIDER_CREDENTIAL"
      && typeof subject === "string"
      && subjects.has(subject)
      && request.headers.get("chatgpt-account-id") === null;
    if (search) {
      return Response.json({
        body: await request.text(),
        cookie: request.headers.get("cookie"),
        origin: request.headers.get("origin"),
        subject,
      });
    }
    const responses = url.href === "https://nanocodex.internal/v1/responses"
      && authorization === "Bearer NANOCODEX_PROVIDER_CREDENTIAL"
      && typeof subject === "string"
      && subjects.has(subject)
      && request.headers.get("chatgpt-account-id") === null;
    if (request.method !== "GET"
      || request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      || request.headers.get("openai-beta") !== "responses_websockets=2026-02-06"
      || !responses) {
      return Response.json({ error: "test_broker_denied" }, { status: 403 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    let pendingResponse;
    server.addEventListener("message", (event) => {
      let command;
      try { command = JSON.parse(String(event.data)); } catch { return; }
      if (command.type === "response.cancel") {
        if (pendingResponse !== undefined) clearTimeout(pendingResponse);
        pendingResponse = undefined;
        return;
      }
      const input = Array.isArray(command.input) ? command.input : [];
      const messages = input.filter((item) => item?.type === "message" && item.role === "user");
      const latest = messages.at(-1);
      const content = Array.isArray(latest?.content) ? latest.content : [];
      const text = content.map((item) => item?.text ?? "").join("").trim();
      pendingResponse = setTimeout(() => {
        pendingResponse = undefined;
        server.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: crypto.randomUUID(),
            status: "completed",
            output: [{
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ROOM_AGENT_OK: " + text.slice(-160) }],
            }],
            usage: null,
          },
        }));
      }, 500);
    });
    server.addEventListener("close", () => {
      if (pendingResponse !== undefined) clearTimeout(pendingResponse);
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "openai-model": "test-model", "x-request-id": crypto.randomUUID() },
    });
  },
};
`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AGENT_IDLE_TIMEOUT_MS: "1000",
          NANOCODEX_ADMIN_TOKEN: "test-admin-token",
          NANOCODEX_ROOM_ALLOCATOR_TOKEN: "test-room-allocator-token",
        },
        workers: [{
          name: "nanocodex-egress",
          modules: true,
          script: TEST_BROKER,
        }],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
