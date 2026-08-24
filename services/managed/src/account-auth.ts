import { DurableObject } from "cloudflare:workers";
import { Handler, Kv } from "accounts/server";

const ACCOUNT_COOKIE = "nanocodex_account";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const API_KEY = /^ncx_live_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;
const ANONYMOUS_SESSION_TOKEN = /^a_[A-Za-z0-9_-]{43}$/;
const accountSessionKey = (token: string) => `session:${token}`;

export function isUserId(value: unknown): value is string {
  return typeof value === "string" && USER_ID.test(value);
}

export const NonceStorage = Kv.NonceStorage;

export interface AccountAuthEnv {
  NANOCODEX_AUTH: DurableObjectNamespace;
  NANOCODEX_USERS: DurableObjectNamespace<UserAccount>;
  NANOCODEX_API_KEYS: DurableObjectNamespace<ApiKeyRecord>;
}

export type Principal = Readonly<{
  kind: "account_session" | "api_key";
  userId: string;
}>;

type UserRecord = Readonly<{
  id: string;
  persistent: boolean;
  createdAt: number;
  lastAuthenticatedAt: number;
}>;

type AccountSessionPayload = Readonly<{
  userId: string;
  issuedAt: number;
  expiresAt: number;
}>;

type ApiKeyMetadata = Readonly<{
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
}>;

type StoredApiKey = ApiKeyMetadata & Readonly<{
  digest: string;
  userId: string;
}>;

export type AgentSummary = Readonly<{
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}>;

export async function routeAccountRequest(
  request: Request,
  env: AccountAuthEnv,
  url: URL,
): Promise<Response | undefined> {
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
    return json({ error: "not_found" }, { status: 404 });
  }
  if (url.pathname.startsWith("/webauthn/")) {
    const originFailure = requireBrowserOrigin(request, url);
    if (originFailure) return originFailure;
    if (url.pathname === "/webauthn/register/options") {
      const principal = await authenticate(request, env, url);
      if (!principal || principal.kind !== "account_session") return unauthorized();
      const body = await readJson(request);
      if (body instanceof Response) return body;
      request = new Request(request, {
        body: JSON.stringify({
          excludeCredentialIds: body.excludeCredentialIds,
          name: "Nanocodex",
          userId: principal.userId,
        }),
        headers: { ...Object.fromEntries(request.headers), "content-type": "application/json" },
      });
    }
    return webAuthnHandler(env, url).fetch(request);
  }
  if (url.pathname === "/v1/me" && request.method === "GET") {
    const resolved = await resolveOrCreateBrowserAccount(request, env, url);
    if (resolved instanceof Response) return resolved;
    const principal = resolved.principal;
    return json({
      user: {
        id: principal.userId,
        persistent: resolved.persistent,
      },
      authentication: principal.kind,
    }, resolved.cookie ? { headers: { "set-cookie": resolved.cookie } } : undefined);
  }
  if (url.pathname === "/v1/api-keys") {
    const principal = await authenticate(request, env, url);
    if (!principal || principal.kind !== "account_session") return unauthorized();
    if (request.method === "GET") {
      return json({ data: await listApiKeys(env, principal.userId) });
    }
    if (request.method === "POST") {
      const originFailure = requireSameOriginMutation(request, url, principal);
      if (originFailure) return originFailure;
      const body = await readJson(request);
      if (body instanceof Response) return body;
      const label = typeof body.label === "string" && body.label.trim()
        ? body.label.trim().slice(0, 120)
        : "API key";
      const created = await createApiKey(env, principal.userId, label);
      return json({ api_key: created.token, key: created.metadata }, { status: 201 });
    }
    return methodNotAllowed();
  }
  const keyMatch = url.pathname.match(/^\/v1\/api-keys\/([A-Za-z0-9_-]{12})$/);
  if (keyMatch) {
    const principal = await authenticate(request, env, url);
    if (!principal || principal.kind !== "account_session") return unauthorized();
    if (request.method !== "DELETE") return methodNotAllowed();
    const originFailure = requireSameOriginMutation(request, url, principal);
    if (originFailure) return originFailure;
    const deleted = await revokeApiKey(env, principal.userId, keyMatch[1]!);
    return deleted ? new Response(null, { status: 204 }) : json({ error: "not_found" }, { status: 404 });
  }
  return undefined;
}

export async function authenticate(
  request: Request,
  env: AccountAuthEnv,
  url = new URL(request.url),
): Promise<Principal | undefined> {
  const cookie = cookieValue(request, ACCOUNT_COOKIE);
  if (cookie && ANONYMOUS_SESSION_TOKEN.test(cookie)) {
    const session = await readBrowserSession(request, env);
    if (session) return { kind: "account_session", userId: session.userId };
  } else {
    const passkey = await webAuthnHandler(env, url).getSession(request);
    const passkeyUserId = passkey?.userId ? decodeUserId(passkey.userId) : undefined;
    if (isUserId(passkeyUserId)) {
      return { kind: "account_session", userId: passkeyUserId };
    }
  }
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length);
  if (!API_KEY.test(token)) return undefined;
  const digest = await sha256(token);
  const stub = env.NANOCODEX_API_KEYS.getByName(digest);
  const response = await stub.fetch("https://api-key.internal/resolve");
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  const record = await response.json<StoredApiKey>();
  if (record.digest !== digest || !isUserId(record.userId)) return undefined;
  return { kind: "api_key", userId: record.userId };
}

export async function authenticatePersistentAccount(
  request: Request,
  env: AccountAuthEnv,
  url = new URL(request.url),
): Promise<Principal | undefined> {
  const principal = await authenticate(request, env, url);
  if (!principal || principal.kind !== "account_session") return undefined;
  const account = await readAccount(env, principal.userId);
  return account?.persistent === true ? principal : undefined;
}

export function requireSameOriginMutation(
  request: Request,
  url: URL,
  principal: Principal,
): Response | undefined {
  if (principal.kind !== "account_session") return undefined;
  return request.headers.get("origin") === url.origin
    ? undefined
    : json({ error: "forbidden_origin" }, { status: 403 });
}

export async function listAgents(env: AccountAuthEnv, userId: string): Promise<AgentSummary[]> {
  const response = await env.NANOCODEX_USERS.getByName(userId).fetch("https://user.internal/agents");
  if (!response.ok) throw new Error("agent listing failed");
  return response.json<AgentSummary[]>();
}

export async function attachAgent(
  env: AccountAuthEnv,
  userId: string,
  agentId: string,
): Promise<void> {
  const response = await env.NANOCODEX_USERS.getByName(userId).fetch(
    "https://user.internal/agents",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    },
  );
  if (!response.ok) throw new Error("agent attachment failed");
  await response.body?.cancel();
}

export async function recordAgentActivity(
  env: AccountAuthEnv,
  userId: string,
  agentId: string,
  summary: Readonly<{ title: string; turnCount: number }>,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await env.NANOCODEX_USERS.getByName(userId).fetch(
        `https://user.internal/agents/${agentId}/activity`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(summary),
        },
      );
      if (!response.ok) throw new Error(`agent activity update failed with HTTP ${response.status}`);
      await response.body?.cancel();
      return;
    } catch (error) {
      failure = error;
      if (attempt < 2) await scheduler.wait(10 * 2 ** attempt);
    }
  }
  throw failure;
}

export async function detachAgent(
  env: AccountAuthEnv,
  userId: string,
  agentId: string,
): Promise<void> {
  const response = await env.NANOCODEX_USERS.getByName(userId).fetch(
    `https://user.internal/agents/${agentId}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) throw new Error("agent detachment failed");
  await response.body?.cancel();
}

function webAuthnHandler(env: AccountAuthEnv, url: URL) {
  return Handler.webAuthn({
    cookieName: ACCOUNT_COOKIE,
    kv: authStore(env, "webauthn"),
    origin: url.origin,
    path: "/webauthn",
    rpId: url.hostname,
    ttl: { session: SESSION_TTL_SECONDS },
    onRegister: async ({ request, userId }) => {
      const decoded = userId ? decodeUserId(userId) : undefined;
      const current = await readBrowserSession(request, env);
      if (!decoded || !current || decoded !== current.userId) {
        throw new Error("passkey identity does not match this browser session");
      }
      await ensureAccount(env, decoded, true);
      const anonymousToken = cookieValue(request, ACCOUNT_COOKIE);
      if (anonymousToken) {
        await authStore(env, "account").delete(accountSessionKey(anonymousToken));
      }
    },
    onAuthenticate: async ({ userId }) => {
      const decoded = userId ? decodeUserId(userId) : undefined;
      if (!isUserId(decoded)) throw new Error("unknown passkey identity");
      await ensureAccount(env, decoded, true);
    },
  });
}

function authStore(env: AccountAuthEnv, name: string): Kv.Kv {
  const namespace = env.NANOCODEX_AUTH as unknown as Parameters<typeof Kv.durableObject>[0];
  return Kv.durableObject(namespace, { name });
}

async function ensureAccount(env: AccountAuthEnv, userId: string, persistent: boolean): Promise<void> {
  if (!isUserId(userId)) {
    throw new Error("invalid account identity");
  }
  const response = await env.NANOCODEX_USERS.getByName(userId).fetch(
    "https://user.internal/account",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: userId, persistent }),
    },
  );
  if (!response.ok) throw new Error("account provisioning failed");
  await response.body?.cancel();
}

async function readAccount(env: AccountAuthEnv, userId: string): Promise<UserRecord | undefined> {
  const response = await env.NANOCODEX_USERS.getByName(userId).fetch("https://user.internal/account");
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  return response.json<UserRecord>();
}

async function resolveOrCreateBrowserAccount(
  request: Request,
  env: AccountAuthEnv,
  url: URL,
): Promise<{ principal: Principal; persistent: boolean; cookie?: string } | Response> {
  const principal = await authenticate(request, env, url);
  if (principal) {
    const cookie = cookieValue(request, ACCOUNT_COOKIE);
    if (principal.kind === "account_session") {
      return { principal, persistent: !cookie || !ANONYMOUS_SESSION_TOKEN.test(cookie) };
    }
    const account = await readAccount(env, principal.userId);
    if (!account) throw new Error("API key account is unavailable");
    return { principal, persistent: account.persistent };
  }

  // An explicit but invalid credential must not silently become a fresh
  // browser account. Cookie-free browser bootstrap is only for requests that
  // did not present either account or bearer authentication.
  if (request.headers.has("authorization")) return unauthorized();
  if (hasCookie(request, ACCOUNT_COOKIE)) {
    return json({ error: "invalid_session" }, {
      status: 401,
      headers: { "set-cookie": clearAccountCookie(new URL(request.url).protocol) },
    });
  }

  const userId = crypto.randomUUID();
  const issuedAt = Math.floor(Date.now() / 1_000);
  const token = `a_${randomBase64Url(32)}`;
  await Promise.all([
    ensureAccount(env, userId, false),
    authStore(env, "account").set(accountSessionKey(token), {
      userId,
      issuedAt,
      expiresAt: issuedAt + SESSION_TTL_SECONDS,
    } satisfies AccountSessionPayload, { ttl: SESSION_TTL_SECONDS }),
  ]);
  return {
    principal: { kind: "account_session", userId },
    persistent: false,
    cookie: serializeAccountCookie(token, new URL(request.url).protocol),
  };
}

async function readBrowserSession(
  request: Request,
  env: AccountAuthEnv,
): Promise<AccountSessionPayload | undefined> {
  const token = cookieValue(request, ACCOUNT_COOKIE);
  if (!token) return undefined;
  const session = await authStore(env, "account").get<AccountSessionPayload>(accountSessionKey(token));
  if (!session || !isUserId(session.userId) || session.expiresAt <= Date.now() / 1_000) {
    return undefined;
  }
  return session;
}

function decodeUserId(value: string): string | undefined {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookie = rawCookie(request, name);
  return cookie.present && /^(?:a_)?[A-Za-z0-9_-]{43}$/.test(cookie.value)
    ? cookie.value
    : undefined;
}

function hasCookie(request: Request, name: string): boolean {
  return rawCookie(request, name).present;
}

function rawCookie(request: Request, name: string): { present: boolean; value: string } {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      return { present: true, value: part.slice(separator + 1).trim() };
    }
  }
  return { present: false, value: "" };
}

function serializeAccountCookie(token: string, protocol: string): string {
  return accountCookie(token, SESSION_TTL_SECONDS, protocol);
}

function clearAccountCookie(protocol: string): string {
  return accountCookie("", 0, protocol);
}

function accountCookie(value: string, maxAge: number, protocol: string): string {
  return [
    `${ACCOUNT_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

function requireBrowserOrigin(request: Request, url: URL): Response | undefined {
  return request.headers.get("origin") === url.origin
    ? undefined
    : json({ error: "forbidden_origin" }, { status: 403 });
}

async function listApiKeys(env: AccountAuthEnv, userId: string): Promise<ApiKeyMetadata[]> {
  const response = await env.NANOCODEX_USERS.getByName(userId).fetch("https://user.internal/api-keys");
  if (!response.ok) throw new Error("API key listing failed");
  return response.json<ApiKeyMetadata[]>();
}

async function createApiKey(
  env: AccountAuthEnv,
  userId: string,
  label: string,
): Promise<{ token: string; metadata: ApiKeyMetadata }> {
  const id = randomBase64Url(9);
  const token = `ncx_live_${id}_${randomBase64Url(32)}`;
  const digest = await sha256(token);
  const metadata: ApiKeyMetadata = {
    id,
    label,
    prefix: `ncx_live_${id}`,
    createdAt: Date.now(),
  };
  const key = env.NANOCODEX_API_KEYS.getByName(digest);
  const initialized = await key.fetch("https://api-key.internal/record", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...metadata, digest, userId } satisfies StoredApiKey),
  });
  if (initialized.status !== 201) throw new Error("API key creation failed");
  await initialized.body?.cancel();
  const attached = await env.NANOCODEX_USERS.getByName(userId).fetch(
    "https://user.internal/api-keys",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...metadata, digest }),
    },
  );
  if (!attached.ok) {
    await key.fetch("https://api-key.internal/record", { method: "DELETE" });
    throw new Error("API key attachment failed");
  }
  await attached.body?.cancel();
  return { token, metadata };
}

async function revokeApiKey(env: AccountAuthEnv, userId: string, id: string): Promise<boolean> {
  const account = env.NANOCODEX_USERS.getByName(userId);
  const found = await account.fetch(`https://user.internal/api-keys/${id}`);
  if (!found.ok) {
    await found.body?.cancel();
    return false;
  }
  const record = await found.json<ApiKeyMetadata & { digest: string }>();
  await env.NANOCODEX_API_KEYS.getByName(record.digest).fetch(
    "https://api-key.internal/record",
    { method: "DELETE" },
  );
  const detached = await account.fetch(`https://user.internal/api-keys/${id}`, { method: "DELETE" });
  return detached.ok;
}

export class UserAccount extends DurableObject<AccountAuthEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/account") {
      if (request.method === "PUT") {
        const body = await request.json<{ id?: unknown; persistent?: unknown }>();
        const id = typeof body.id === "string" ? body.id.toLowerCase() : "";
        if (!isUserId(id) || typeof body.persistent !== "boolean") {
          return json({ error: "invalid_account" }, { status: 400 });
        }
        const now = Date.now();
        const current = await this.ctx.storage.get<UserRecord>("account");
        const record: UserRecord = {
          id,
          persistent: current?.persistent === true || body.persistent,
          createdAt: current?.createdAt ?? now,
          lastAuthenticatedAt: now,
        };
        await this.ctx.storage.put("account", record);
        return json(record);
      }
      if (request.method === "GET") {
        const record = await this.ctx.storage.get<UserRecord>("account");
        return record ? json(record) : json({ error: "not_found" }, { status: 404 });
      }
    }
    if (url.pathname === "/api-keys") {
      const keys = await this.ctx.storage.get<Record<string, ApiKeyMetadata & { digest: string }>>("apiKeys") ?? {};
      if (request.method === "GET") {
        return json(Object.values(keys).map(({ digest: _digest, ...metadata }) => metadata));
      }
      if (request.method === "POST") {
        const metadata = await request.json<ApiKeyMetadata & { digest?: unknown }>();
        if (!/^[A-Za-z0-9_-]{12}$/.test(metadata.id) || typeof metadata.digest !== "string") {
          return json({ error: "invalid_api_key" }, { status: 400 });
        }
        keys[metadata.id] = metadata as ApiKeyMetadata & { digest: string };
        await this.ctx.storage.put("apiKeys", keys);
        return new Response(null, { status: 204 });
      }
    }
    const keyMatch = url.pathname.match(/^\/api-keys\/([A-Za-z0-9_-]{12})$/);
    if (keyMatch) {
      const keys = await this.ctx.storage.get<Record<string, ApiKeyMetadata & { digest: string }>>("apiKeys") ?? {};
      const record = keys[keyMatch[1]!];
      if (!record) return json({ error: "not_found" }, { status: 404 });
      if (request.method === "GET") return json(record);
      if (request.method === "DELETE") {
        delete keys[keyMatch[1]!];
        await this.ctx.storage.put("apiKeys", keys);
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname === "/agents") {
      const agents = await this.ctx.storage.get<string[]>("agents") ?? [];
      const summaries = await this.ctx.storage.get<Record<string, AgentSummary>>("agentSummaries") ?? {};
      if (request.method === "GET") {
        return json(agents.map((id) => summaries[id] ?? {
          id,
          title: "",
          createdAt: 0,
          updatedAt: 0,
          turnCount: 0,
        }));
      }
      if (request.method === "POST") {
        const body = await request.json<{ agentId?: unknown }>();
        const agentId = typeof body.agentId === "string" ? body.agentId : "";
        if (!/^[0-9a-f-]{36}$/.test(agentId)) {
          return json({ error: "invalid_agent" }, { status: 400 });
        }
        if (!agents.includes(agentId)) {
          agents.push(agentId);
          const now = Date.now();
          summaries[agentId] = { id: agentId, title: "", createdAt: now, updatedAt: now, turnCount: 0 };
          await this.ctx.storage.put({ agents, agentSummaries: summaries });
        }
        return new Response(null, { status: 204 });
      }
    }
    const activityMatch = url.pathname.match(/^\/agents\/([0-9a-f-]{36})\/activity$/);
    if (activityMatch && request.method === "POST") {
      const agents = await this.ctx.storage.get<string[]>("agents") ?? [];
      const agentId = activityMatch[1]!;
      if (!agents.includes(agentId)) return json({ error: "not_found" }, { status: 404 });
      const body = await request.json<{ title?: unknown; turnCount?: unknown }>();
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 56) : "";
      const turnCount = Number.isSafeInteger(body.turnCount) && Number(body.turnCount) >= 0
        ? Number(body.turnCount) : undefined;
      if (turnCount === undefined) return json({ error: "invalid_activity" }, { status: 400 });
      const summaries = await this.ctx.storage.get<Record<string, AgentSummary>>("agentSummaries") ?? {};
      const current = summaries[agentId];
      const now = Date.now();
      summaries[agentId] = {
        id: agentId,
        title: current?.title || title,
        createdAt: current?.createdAt || now,
        updatedAt: now,
        turnCount: Math.max(current?.turnCount ?? 0, turnCount),
      };
      await this.ctx.storage.put("agentSummaries", summaries);
      return new Response(null, { status: 204 });
    }
    const agentMatch = url.pathname.match(/^\/agents\/([0-9a-f-]{36})$/);
    if (agentMatch && request.method === "DELETE") {
      const agents = await this.ctx.storage.get<string[]>("agents") ?? [];
      const next = agents.filter((agent) => agent !== agentMatch[1]);
      if (next.length === agents.length) return json({ error: "not_found" }, { status: 404 });
      const summaries = await this.ctx.storage.get<Record<string, AgentSummary>>("agentSummaries") ?? {};
      delete summaries[agentMatch[1]!];
      await this.ctx.storage.put({ agents: next, agentSummaries: summaries });
      return new Response(null, { status: 204 });
    }
    return json({ error: "not_found" }, { status: 404 });
  }
}

export class ApiKeyRecord extends DurableObject<AccountAuthEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/resolve" && request.method === "GET") {
      const record = await this.ctx.storage.get<StoredApiKey>("record");
      return record ? json(record) : json({ error: "not_found" }, { status: 404 });
    }
    if (url.pathname === "/record" && request.method === "PUT") {
      if (await this.ctx.storage.get("record")) return json({ error: "conflict" }, { status: 409 });
      const record = await request.json<StoredApiKey>();
      if (!isUserId(record.userId) || !/^[A-Za-z0-9_-]{43}$/.test(record.digest)) {
        return json({ error: "invalid_api_key" }, { status: 400 });
      }
      await this.ctx.storage.put("record", record);
      return new Response(null, { status: 201 });
    }
    if (url.pathname === "/record" && request.method === "DELETE") {
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    return json({ error: "not_found" }, { status: 404 });
  }
}

function randomBase64Url(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "expected_json" }, { status: 415 });
  }
  try {
    const value = await request.json<unknown>();
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...init.headers,
    },
  });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, { status: 401 });
}

function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, { status: 405 });
}
