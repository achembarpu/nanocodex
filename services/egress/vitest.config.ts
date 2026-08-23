import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const TEST_CHATGPT_EGRESS = `
export class ChatGptEgress {
  fetch(request) {
    const url = new URL(request.url);
    url.hostname = "chatgpt.com";
    return Response.json({
      url: url.href,
      credential: request.headers.get("authorization")?.startsWith("Bearer ")
        ? "chatgpt"
        : "missing",
      account: request.headers.get("chatgpt-account-id"),
      subject: request.headers.get("x-nanocodex-subject"),
      leaked: request.headers.get("x-should-not-forward"),
    }, { headers: { authorization: "Bearer reflected-provider-secret" } });
  }
}
`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.broker.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          CREDENTIAL_ENCRYPTION_KEY: TEST_KEY,
          ALLOW_LOCAL_CREDENTIAL_CLAIM: "true",
          LOCAL_CHATGPT_BOOTSTRAP: JSON.stringify({
            access_token: jwt({ exp: 4_102_444_800, marker: "local-access" }),
            refresh_token: "local-refresh-secret",
            account_id: "local-account",
            expires_at: 4_102_444_800_000,
          }),
          NANOCODEX_BROKER_PROBE_TOKEN: "probe-token-that-is-at-least-thirty-two-bytes",
        },
        workers: [{
          name: "nanocodex",
          modules: true,
          script: TEST_CHATGPT_EGRESS,
          durableObjects: { CHATGPT_EGRESS: "ChatGptEgress" },
        }],
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (request.method === "POST" && url.pathname.endsWith("/deviceauth/usercode")) {
            return Response.json({
              device_auth_id: "device-secret",
              user_code: "ABCD-EFGH",
              interval: "1",
            });
          }
          if (request.method === "POST" && url.pathname.endsWith("/deviceauth/token")) {
            return Response.json({
              authorization_code: "authorization-secret",
              code_challenge: "challenge-secret",
              code_verifier: "verifier-secret",
            });
          }
          if (request.method === "POST" && url.pathname.endsWith("/oauth/token")) {
            const contentType = request.headers.get("content-type") ?? "";
            if (contentType.startsWith("application/x-www-form-urlencoded")) {
              return Response.json({
                access_token: jwt({ exp: 4_102_444_800, marker: "chatgpt-access" }),
                refresh_token: "chatgpt-refresh-secret",
                id_token: jwt({
                  "https://api.openai.com/auth": {
                    chatgpt_account_id: "chatgpt-account",
                    chatgpt_account_is_fedramp: false,
                  },
                }),
              });
            }
            return Response.json({
              access_token: jwt({ exp: 4_102_444_800, marker: "chatgpt-refreshed" }),
              refresh_token: "chatgpt-refresh-rotated",
            });
          }
          if (url.hostname === "api.openai.com" || url.hostname === "chatgpt.com") {
            const authorization = request.headers.get("authorization");
            return Response.json({
              url: request.url,
              credential: authorization === "Bearer sk-user-a-secret"
                ? "openai-a"
                : authorization === "Bearer sk-user-b-secret"
                ? "openai-b"
                : authorization?.startsWith("Bearer ")
                ? "chatgpt"
                : "missing",
              account: request.headers.get("chatgpt-account-id"),
              subject: request.headers.get("x-nanocodex-subject"),
              leaked: request.headers.get("x-should-not-forward"),
            }, { headers: { authorization: "Bearer reflected-provider-secret" } });
          }
          return new Response("unexpected outbound request", { status: 599 });
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.test`;
}
