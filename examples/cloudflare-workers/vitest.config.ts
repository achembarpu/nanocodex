import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

let initialRefreshConsumed = false;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AGENT_IDLE_TIMEOUT_MS: "1000",
          CHATGPT_ACCESS_TOKEN: "e30.eyJleHAiOjF9.test",
          CHATGPT_ACCOUNT_ID: "test-account-id",
          CHATGPT_REFRESH_TOKEN: "test-refresh-token",
          CHATGPT_ISSUER: "http://127.0.0.1:8799",
          NANOCODEX_ADMIN_TOKEN: "test-admin-token",
          NANOCODEX_AUTH_MODE: "api_key",
          OPENAI_API_KEY: "test-openai-key",
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (request.method !== "POST" || url.href !== "http://127.0.0.1:8799/oauth/token") {
            return new Response("not found", { status: 404 });
          }
          const payload = await request.json<{ refresh_token?: unknown }>();
          if (payload.refresh_token !== "test-refresh-token" || initialRefreshConsumed) {
            return Response.json({ error: { code: "refresh_token_invalidated" } }, { status: 401 });
          }
          initialRefreshConsumed = true;
          await new Promise((resolve) => setTimeout(resolve, 25));
          return Response.json({
            access_token: testJwt({ exp: 4_102_444_800 }),
            refresh_token: "test-rotated-refresh-token",
            id_token: testJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: "test-account-id" },
            }),
          });
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});

function testJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.test`;
}
