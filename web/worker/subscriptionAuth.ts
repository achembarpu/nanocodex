import { CredentialVault, type CredentialVaultEnv, type EncryptedEnvelope } from "./credentialVault.ts";

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ISSUER = "https://auth.openai.com";
const REFRESH_EARLY_MS = 5 * 60_000;
export const CHATGPT_LOGIN_TTL_MS = 15 * 60_000;
export const CHATGPT_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const USAGE_WINDOW_MS = 60_000;
const SOCKET_LEASE_MS = 2 * 60 * 60_000;
const MAX_ACTIVE_SOCKETS = 3;
const OPERATION_LIMITS = {
  socket: 12,
  search: 30,
  image: 4,
} as const;

export type ChatGptOperation = "health" | keyof typeof OPERATION_LIMITS;

export type ChatGptCredential = {
  kind: "chatgpt";
  accessToken: string;
  accountId: string;
  fedramp: boolean;
  revision: number;
};

type StoredCredential = ChatGptCredential & {
  refreshToken: string;
  expiresAt: number | null;
};

type StoredUsage = {
  windows: Partial<Record<keyof typeof OPERATION_LIMITS, { startedAt: number; count: number }>>;
  socketLeases: Record<string, number>;
};

type PendingLogin = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
};

type DeviceCodeResponse = {
  device_auth_id?: unknown;
  user_code?: unknown;
  usercode?: unknown;
  interval?: unknown;
};

type DeviceTokenResponse = {
  authorization_code?: unknown;
  code_verifier?: unknown;
};

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
};

export class ChatGptSession {
  readonly #state: DurableObjectState;
  readonly #issuer: string;
  readonly #vault: CredentialVault;
  #refreshing?: { revision: number; promise: Promise<StoredCredential> };

  constructor(
    state: DurableObjectState,
    env: CredentialVaultEnv & { CHATGPT_ISSUER?: string },
  ) {
    this.#state = state;
    this.#issuer = (env.CHATGPT_ISSUER?.trim() || DEFAULT_ISSUER).replace(/\/$/, "");
    this.#vault = new CredentialVault(env, `chatgpt/${state.id?.toString() ?? "test"}`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/start") {
        const pending = await this.#start();
        return Response.json(publicPending(pending), { headers: noStoreHeaders() });
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return Response.json(await this.#status(), { headers: noStoreHeaders() });
      }
      if (request.method === "POST" && url.pathname === "/credential") {
        const body = await request.json<{ operation?: unknown; leaseId?: unknown }>();
        const operation = parseOperation(body.operation);
        if (!operation) {
          return Response.json({ error: "invalid operation" }, { status: 400, headers: noStoreHeaders() });
        }
        const credential = await this.#currentCredential();
        if (!credential) {
          return Response.json({ error: "not_authenticated" }, { status: 404, headers: noStoreHeaders() });
        }
        if (!await this.#consume(operation, body.leaseId)) {
          return Response.json(
            { error: "session_rate_limit_exceeded" },
            { status: 429, headers: { ...noStoreHeaders(), "retry-after": "60" } },
          );
        }
        return Response.json(publicCredential(credential), { headers: noStoreHeaders() });
      }
      if (request.method === "DELETE" && url.pathname === "/lease") {
        const body = await request.json<{ leaseId?: unknown }>();
        await this.#releaseLease(body.leaseId);
        return new Response(null, { status: 204, headers: noStoreHeaders() });
      }
      if (request.method === "POST" && url.pathname === "/recover") {
        const body = await request.json<{ revision?: unknown }>();
        if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0) {
          return Response.json({ error: "invalid revision" }, { status: 400, headers: noStoreHeaders() });
        }
        const credential = await this.#refresh(Number(body.revision));
        return Response.json(publicCredential(credential), { headers: noStoreHeaders() });
      }
      if (request.method === "DELETE") {
        await this.#state.storage.deleteAll();
        return new Response(null, { status: 204, headers: noStoreHeaders() });
      }
      return Response.json({ error: "not_found" }, { status: 404, headers: noStoreHeaders() });
    } catch (error) {
      return Response.json({ error: safeError(error) }, { status: 503, headers: noStoreHeaders() });
    }
  }

  async alarm(): Promise<void> {
    await this.#state.storage.deleteAll();
  }

  async #start(): Promise<PendingLogin> {
    const response = await fetch(`${this.#issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
    });
    const body = await readJson<DeviceCodeResponse>(response);
    if (!response.ok) throw new Error(`ChatGPT login start failed with HTTP ${response.status}`);
    const deviceAuthId = requiredString(body.device_auth_id, "device authorization ID");
    const userCode = requiredString(body.user_code ?? body.usercode, "device user code");
    const intervalSeconds = parseInterval(body.interval);
    const now = Date.now();
    const pending: PendingLogin = {
      deviceAuthId,
      userCode,
      verificationUrl: `${this.#issuer}/codex/device`,
      intervalMs: intervalSeconds * 1_000,
      nextPollAt: now + intervalSeconds * 1_000,
      expiresAt: now + CHATGPT_LOGIN_TTL_MS,
    };
    await this.#state.storage.delete("credential");
    await this.#state.storage.delete("usage");
    await this.#state.storage.put("pending", pending);
    await this.#state.storage.setAlarm(pending.expiresAt);
    return pending;
  }

  async #status(): Promise<Record<string, unknown>> {
    const credential = await this.#currentCredential();
    if (credential) {
      return {
        state: "authenticated",
        accountId: credential.accountId,
        expiresAt: credential.expiresAt,
      };
    }
    const pending = await this.#state.storage.get<PendingLogin>("pending");
    if (!pending) return { state: "signed_out" };
    const now = Date.now();
    if (pending.expiresAt <= now) {
      await this.#state.storage.delete("pending");
      return { state: "expired" };
    }
    if (pending.nextPollAt > now) return publicPending(pending);
    const result = await this.#poll(pending);
    if (!result) return publicPending(pending);
    await this.#putCredential(result);
    await this.#state.storage.delete("pending");
    await this.#state.storage.setAlarm(now + CHATGPT_SESSION_TTL_MS);
    return {
      state: "authenticated",
      accountId: result.accountId,
      expiresAt: result.expiresAt,
    };
  }

  async #poll(pending: PendingLogin): Promise<StoredCredential | undefined> {
    pending.nextPollAt = Date.now() + pending.intervalMs;
    await this.#state.storage.put("pending", pending);
    const response = await fetch(`${this.#issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: pending.deviceAuthId,
        user_code: pending.userCode,
      }),
    });
    if (response.status === 403 || response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    const body = await readJson<DeviceTokenResponse>(response);
    if (!response.ok) throw new Error(`ChatGPT device authorization failed with HTTP ${response.status}`);
    const authorizationCode = requiredString(body.authorization_code, "authorization code");
    const codeVerifier = requiredString(body.code_verifier, "PKCE verifier");
    return this.#exchange(authorizationCode, codeVerifier);
  }

  async #exchange(authorizationCode: string, codeVerifier: string): Promise<StoredCredential> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${this.#issuer}/deviceauth/callback`,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    });
    const response = await fetch(`${this.#issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const tokens = await readJson<TokenResponse>(response);
    if (!response.ok) throw new Error(`ChatGPT token exchange failed with HTTP ${response.status}`);
    return credentialFromTokens(tokens, undefined, 0);
  }

  async #currentCredential(): Promise<StoredCredential | undefined> {
    const envelope = await this.#state.storage.get<EncryptedEnvelope>("credential");
    if (!envelope) return undefined;
    const opened = await this.#vault.open<StoredCredential>(envelope);
    let credential = opened.value;
    if (opened.reseal) await this.#putCredential(credential);
    if (credential.expiresAt !== null && credential.expiresAt <= Date.now() + REFRESH_EARLY_MS) {
      credential = await this.#refresh(credential.revision);
    }
    return credential;
  }

  async #refresh(rejectedRevision: number): Promise<StoredCredential> {
    const envelope = await this.#state.storage.get<EncryptedEnvelope>("credential");
    const current = envelope ? (await this.#vault.open<StoredCredential>(envelope)).value : undefined;
    if (!current) throw new Error("ChatGPT credentials are not initialized");
    if (current.revision !== rejectedRevision) return current;
    if (this.#refreshing?.revision === rejectedRevision) return this.#refreshing.promise;
    const promise = this.#performRefresh(current);
    this.#refreshing = { revision: rejectedRevision, promise };
    try {
      return await promise;
    } finally {
      if (this.#refreshing?.promise === promise) this.#refreshing = undefined;
    }
  }

  async #performRefresh(current: StoredCredential): Promise<StoredCredential> {
    if (!current.refreshToken) throw new Error("ChatGPT login expired; sign in again");
    const response = await fetch(`${this.#issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      }),
    });
    const tokens = await readJson<TokenResponse>(response);
    if (!response.ok) throw new Error(`ChatGPT token refresh failed with HTTP ${response.status}`);
    const next = credentialFromTokens(tokens, current, current.revision + 1);
    if (next.accountId !== current.accountId) {
      throw new Error("the refreshed ChatGPT credential changed accounts");
    }
    await this.#putCredential(next);
    return next;
  }

  async #putCredential(credential: StoredCredential): Promise<void> {
    await this.#state.storage.put("credential", await this.#vault.seal(credential));
  }

  async #consume(operation: ChatGptOperation, leaseId: unknown): Promise<boolean> {
    if (operation === "health") return true;
    const now = Date.now();
    const usage = await this.#state.storage.get<StoredUsage>("usage") ?? {
      windows: {},
      socketLeases: {},
    };
    usage.socketLeases = Object.fromEntries(
      Object.entries(usage.socketLeases).filter(([, expiresAt]) => expiresAt > now),
    );
    const current = usage.windows[operation];
    const window = !current || current.startedAt + USAGE_WINDOW_MS <= now
      ? { startedAt: now, count: 0 }
      : current;
    if (window.count >= OPERATION_LIMITS[operation]) return false;
    if (operation === "socket") {
      if (!isLeaseId(leaseId) || Object.keys(usage.socketLeases).length >= MAX_ACTIVE_SOCKETS) {
        return false;
      }
      usage.socketLeases[leaseId] = now + SOCKET_LEASE_MS;
    }
    window.count += 1;
    usage.windows[operation] = window;
    await this.#state.storage.put("usage", usage);
    return true;
  }

  async #releaseLease(leaseId: unknown): Promise<void> {
    if (!isLeaseId(leaseId)) return;
    const usage = await this.#state.storage.get<StoredUsage>("usage");
    if (!usage || !(leaseId in usage.socketLeases)) return;
    delete usage.socketLeases[leaseId];
    await this.#state.storage.put("usage", usage);
  }
}

function credentialFromTokens(
  tokens: TokenResponse,
  previous: StoredCredential | undefined,
  revision: number,
): StoredCredential {
  const accessToken = requiredString(tokens.access_token, "access token");
  const refreshToken = optionalString(tokens.refresh_token) ?? previous?.refreshToken ?? "";
  const idToken = optionalString(tokens.id_token);
  const claims = idToken ? jwtPayload(idToken) : undefined;
  const authClaims = asObject(claims?.["https://api.openai.com/auth"]);
  const accountId = optionalString(authClaims?.chatgpt_account_id) ?? previous?.accountId;
  if (!accountId) throw new Error("ChatGPT token response omitted the account ID");
  const fedramp = typeof authClaims?.chatgpt_account_is_fedramp === "boolean"
    ? authClaims.chatgpt_account_is_fedramp
    : previous?.fedramp ?? false;
  return {
    kind: "chatgpt",
    accessToken,
    refreshToken,
    accountId,
    fedramp,
    revision,
    expiresAt: jwtExpiration(accessToken),
  };
}

function publicCredential(credential: StoredCredential): ChatGptCredential {
  return {
    kind: "chatgpt",
    accessToken: credential.accessToken,
    accountId: credential.accountId,
    fedramp: credential.fedramp,
    revision: credential.revision,
  };
}

function publicPending(pending: PendingLogin) {
  return {
    state: "pending",
    verificationUrl: pending.verificationUrl,
    userCode: pending.userCode,
    expiresAt: pending.expiresAt,
    pollAfterMs: Math.max(250, pending.nextPollAt - Date.now()),
  };
}

function parseOperation(value: unknown): ChatGptOperation | undefined {
  return value === "health" || value === "socket" || value === "search" || value === "image"
    ? value
    : undefined;
}

function isLeaseId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function noStoreHeaders() {
  return { "cache-control": "no-store" };
}

function parseInterval(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30) : 5;
}

function requiredString(value: unknown, name: string): string {
  const found = optionalString(value);
  if (!found) throw new Error(`ChatGPT response omitted the ${name}`);
  return found;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jwtExpiration(token: string): number | null {
  const payload = jwtPayload(token);
  return typeof payload?.exp === "number" && Number.isFinite(payload.exp)
    ? payload.exp * 1_000
    : null;
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      encoded.length + ((4 - encoded.length % 4) % 4),
      "=",
    );
    return asObject(JSON.parse(atob(base64)));
  } catch {
    return undefined;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`ChatGPT returned invalid JSON with HTTP ${response.status}`);
  }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`ChatGPT response exceeded ${limit} bytes`);
    }
    body += decoder.decode(value, { stream: true });
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
