import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

let refreshes = 0;
let currentRefreshToken = "refresh-token-1";
let refreshMode: "normal" | "malformed" = "normal";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.broker.jsonc" },
      miniflare: {
        bindings: {
          CODEX_OAUTH_BOOTSTRAP: JSON.stringify({
            access_token: jwt({ exp: 1, marker: "expired" }),
            refresh_token: currentRefreshToken,
            account_id: "account-1",
            expires_at: 1_000,
          }),
          GITHUB_READ_TOKEN: "github-real-token",
          OPENAI_API_KEY: "openai-real-key",
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.href === "https://test-control.invalid/refresh-count") {
            return Response.json({ refreshes });
          }
          if (request.method === "POST"
            && url.href === "https://test-control.invalid/refresh-mode") {
            const body = await request.json() as { mode?: unknown };
            if (body.mode !== "normal" && body.mode !== "malformed") {
              return Response.json({ error: "invalid_mode" }, { status: 400 });
            }
            refreshMode = body.mode;
            return Response.json({ ok: true });
          }
          if (request.method === "POST" && url.href === "https://auth.openai.com/oauth/token") {
            const body = await request.json() as Record<string, unknown>;
            if (body.client_id !== "app_EMoamEEZ73f0CkXaXp7hrann"
              || body.grant_type !== "refresh_token"
              || body.refresh_token !== currentRefreshToken
              || Object.keys(body).sort().join(",") !== "client_id,grant_type,refresh_token"
              || request.headers.get("content-type") !== "application/json") {
              return Response.json({ error: "invalid_grant" }, { status: 400 });
            }
            refreshes += 1;
            currentRefreshToken = `refresh-token-${refreshes + 1}`;
            if (refreshMode === "malformed") {
              return Response.json({ refresh_token: currentRefreshToken });
            }
            return Response.json({
              access_token: jwt({ exp: 4_102_444_800, marker: `access-${refreshes}` }),
              refresh_token: currentRefreshToken,
              id_token: jwt({
                "https://api.openai.com/auth": {
                  chatgpt_account_id: "account-1",
                  chatgpt_account_is_fedramp: false,
                },
              }),
            });
          }
          if (request.method === "GET"
            && url.href === "https://chatgpt.com/backend-api/codex/responses") {
            const authorization = request.headers.get("authorization") ?? "";
            const marker = jwtMarker(authorization.replace(/^Bearer /, ""));
            if (request.headers.get("x-client-request-id") === "recover" && marker === "access-1") {
              return new Response("rejected", { status: 401 });
            }
            if (request.headers.get("x-client-request-id") === "redirect") {
              return new Response(null, {
                status: 302,
                headers: { location: "https://attacker.invalid/collect" },
              });
            }
            return Response.json({
              authorization,
              account: request.headers.get("chatgpt-account-id"),
              marker,
              leaked: request.headers.get("x-should-not-forward"),
              redirect: request.redirect,
            });
          }
          if (request.method === "GET" && url.href === "https://api.openai.com/v1/responses") {
            return Response.json({
              authorization: request.headers.get("authorization"),
              leaked: request.headers.get("x-should-not-forward"),
              redirect: request.redirect,
            });
          }
          if (request.method === "GET" && url.href === "https://api.github.com/user") {
            return Response.json({
              authorization: request.headers.get("authorization"),
              leaked: request.headers.get("x-should-not-forward"),
            });
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

function jwtMarker(token: string): string | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof payload.marker === "string" ? payload.marker : undefined;
  } catch {
    return undefined;
  }
}
