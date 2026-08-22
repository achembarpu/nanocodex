import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_BROKER = `
export default {
  fetch(request) {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    const codex = url.href === "https://chatgpt.com/backend-api/codex/responses"
      && authorization === "Bearer NANOCODEX_CODEX_OAUTH"
      && request.headers.get("chatgpt-account-id") === "NANOCODEX_CODEX_ACCOUNT";
    const openai = url.href === "https://api.openai.com/v1/responses"
      && authorization === "Bearer NANOCODEX_OPENAI_API_KEY";
    if (request.method !== "GET"
      || request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      || request.headers.get("openai-beta") !== "responses_websockets=2026-02-06"
      || (!codex && !openai)) {
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
          NANOCODEX_AUTH_MODE: "api_key",
        },
        workers: [{
          name: "nanocodex-egress-broker-example",
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
