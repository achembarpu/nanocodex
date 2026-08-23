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
      const body = await request.text();
      let value;
      try { value = JSON.parse(body); } catch {}
      if (typeof value?.id === "string"
        && value?.model === "gpt-5.6-sol"
        && value?.commands?.search_query?.[0]?.q === "managed web"
        && value?.settings?.allowed_callers?.[0] === "direct"
        && value?.settings?.external_web_access === true
        && value?.max_output_tokens === 10000) {
        return Response.json({ output: "MANAGED_WEB_SEARCH_OK" });
      }
      return Response.json({
        body,
        cookie: request.headers.get("cookie"),
        origin: request.headers.get("origin"),
        subject,
      });
    }
    const image = url.href === "https://nanocodex.internal/v1/images/generations"
      && request.method === "POST"
      && authorization === "Bearer NANOCODEX_PROVIDER_CREDENTIAL"
      && typeof subject === "string"
      && subjects.has(subject);
    if (image) {
      const value = await request.json();
      if (value?.model === "gpt-image-2" && value?.prompt === "draw managed") {
        return Response.json({ data: [{ b64_json: "TUFOQUdFRF9JTUFHRV9PSw==" }] });
      }
      return Response.json({ error: { message: "invalid managed image request" } }, { status: 400 });
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
      const toolOutput = input.find((item) => (
        item?.type === "function_call_output" && item.call_id === "managed-web"
      ));
      const imageOutput = input.find((item) => (
        item?.type === "function_call_output" && item.call_id === "managed-image"
      ));
      pendingResponse = setTimeout(() => {
        pendingResponse = undefined;
        if (toolOutput && imageOutput) {
          const valid = String(toolOutput.output).includes("MANAGED_WEB_SEARCH_OK")
            && String(imageOutput.output).includes("TUFOQUdFRF9JTUFHRV9PSw==");
          server.send(JSON.stringify({
            type: "response.completed",
            response: {
              id: crypto.randomUUID(),
              status: "completed",
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: valid ? "MANAGED_WEB_OK" : "MANAGED_WEB_BAD" }],
              }],
              usage: null,
            },
          }));
          return;
        }
        if (text === "E2E_MANAGED_WEB") {
          server.send(JSON.stringify({
            type: "response.completed",
            response: {
              id: crypto.randomUUID(),
              status: "completed",
              output: [{
                type: "function_call",
                call_id: "managed-web",
                name: "web__run",
                arguments: JSON.stringify({ search_query: [{ q: "managed web" }] }),
              }, {
                type: "function_call",
                call_id: "managed-image",
                name: "image_gen__imagegen",
                arguments: JSON.stringify({ prompt: "draw managed" }),
              }],
              usage: null,
            },
          }));
          return;
        }
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
