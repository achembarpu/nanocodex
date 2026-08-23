import { authenticate, type AccountAuthEnv } from "./account-auth";
import { bindAgentCredential } from "./credentials";

const MODEL_HOST = "nanocodex.internal";
const STATUS_HOST = "broker.internal";
const STATUS_PATH = "/.well-known/nanocodex/model-status";
const MODEL_PATHS = new Set([
  "/v1/responses",
  "/v1/search",
  "/v1/images/generations",
  "/v1/images/edits",
]);

type BrowserModelEnv = AccountAuthEnv & { NANOCODEX: Fetcher };

/**
 * Authenticates browser-owned model traffic inside the private managed Worker,
 * binds one opaque broker subject to the account, and forwards no account
 * cookie beyond this boundary.
 */
export async function routeBrowserModel(
  request: Request,
  env: BrowserModelEnv,
  url: URL,
): Promise<Response | undefined> {
  const status = url.protocol === "https:" && url.hostname === STATUS_HOST
    && !url.port && !url.search && !url.hash && url.pathname === STATUS_PATH
    && request.method === "GET";
  const model = url.protocol === "https:" && url.hostname === MODEL_HOST
    && !url.port && !url.search && !url.hash && MODEL_PATHS.has(url.pathname);
  if (!status && !model) return undefined;

  const authenticationHeaders = new Headers(request.headers);
  authenticationHeaders.delete("authorization");
  authenticationHeaders.delete("x-nanocodex-subject");
  const principal = await authenticate(
    new Request(request, { headers: authenticationHeaders }),
    env,
    url,
  );
  if (!principal || principal.kind !== "account_session") {
    return Response.json({ error: "unauthorized" }, {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  const subject = await browserModelSubject(principal.userId);
  try {
    await bindAgentCredential(env.NANOCODEX, subject, principal.userId);
  } catch {
    return Response.json({ error: "credential_broker_unavailable" }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.set("x-nanocodex-subject", subject);
  return env.NANOCODEX.fetch(new Request(request, { headers }));
}

async function browserModelSubject(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`browser-model-v1:${userId}`),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
