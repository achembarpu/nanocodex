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
          GITHUB_OAUTH_CLIENT_ID: "github-client-id",
          GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
          GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
          GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
        },
        workers: [{
          name: "nanocodex",
          modules: true,
          script: TEST_CHATGPT_EGRESS,
          durableObjects: { CHATGPT_EGRESS: "ChatGptEgress" },
        }],
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (request.method === "POST" && url.hostname === "github.com"
            && url.pathname === "/login/oauth/access_token") {
            const body = await request.clone().formData();
            const code = String(body.get("code") ?? "");
            return Response.json({
              access_token: code === "github-code"
                ? "github-connector-access"
                : `github-${code.replace(/-code$/, "")}-access`,
              token_type: "bearer",
              scope: "repo,workflow",
              ...(code === "expired-code" ? { expires_in: 1 } : {}),
            });
          }
          if (request.method === "GET" && url.hostname === "api.github.com"
            && url.pathname === "/user") {
            return Response.json({ id: 42, login: "nanocat", name: "Nano Cat" });
          }
          if (request.method === "POST" && url.hostname === "oauth2.googleapis.com"
            && url.pathname === "/token") {
            const body = await request.clone().formData();
            if (body.get("grant_type") === "refresh_token") {
              const drive = body.get("refresh_token") === "gdrive-connector-refresh";
              return Response.json({
                access_token: drive ? "gdrive-refreshed-access" : "gmail-refreshed-access",
                expires_in: 3_600,
                token_type: "Bearer",
              });
            }
            const drive = body.get("code") === "gdrive-code";
            const expiring = body.get("code") === "gmail-expiring-code";
            return Response.json({
              access_token: drive ? "gdrive-connector-access" : "gmail-connector-access",
              ...(body.get("code") === "gmail-no-refresh-code" ? {} : {
                refresh_token: drive ? "gdrive-connector-refresh" : "gmail-connector-refresh",
              }),
              expires_in: expiring || body.get("code") === "gmail-no-refresh-code" ? 1 : 3_600,
              token_type: "Bearer",
              scope: drive
                ? "openid email profile https://www.googleapis.com/auth/drive"
                : "openid email https://mail.google.com/",
            });
          }
          if (request.method === "GET" && url.hostname === "openidconnect.googleapis.com"
            && url.pathname === "/v1/userinfo") {
            const drive = request.headers.get("authorization") === "Bearer gdrive-connector-access";
            return Response.json({
              sub: drive ? "google-drive-account" : "google-gmail-account",
              email: drive ? "drive@example.test" : "mail@example.test",
              email_verified: true,
              name: drive ? "Drive User" : "Mail User",
            });
          }
          if ((url.hostname === "api.github.com"
              || url.hostname === "gmail.googleapis.com"
              || url.hostname === "www.googleapis.com")) {
            const authorization = request.headers.get("authorization") ?? "";
            if (url.searchParams.has("redirect")) {
              return new Response(null, {
                status: 302,
                headers: { location: "https://attacker.example/collect" },
              });
            }
            if (url.searchParams.has("oversize")) {
              return new Response("bounded", { headers: { "content-length": "9000000" } });
            }
            if (url.searchParams.has("reflect_credential")) {
              return Response.json({ reflected: authorization });
            }
            const account = authorization === "Bearer github-alpha-access" ? "alpha"
              : authorization === "Bearer github-beta-access" ? "beta"
              : authorization === "Bearer gmail-refreshed-access" ? "gmail-refreshed"
              : authorization.startsWith("Bearer ") ? "connected" : "missing";
            return Response.json({
              account,
              host: url.hostname,
              path: url.pathname,
              method: request.method,
              body: request.body ? await request.text() : null,
              caller_cookie: request.headers.has("cookie"),
              caller_proxy_credential: request.headers.has("proxy-authorization"),
              subject: request.headers.get("x-nanocodex-subject"),
            }, {
              headers: {
                authorization,
                "set-cookie": "provider-secret=cookie",
              },
            });
          }
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
