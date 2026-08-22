import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY = "codex-oauth-credential";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_EARLY_MS = 5 * 60_000;
const MAX_OAUTH_RESPONSE_BYTES = 16 * 1024;
const MIN_ALARM_DELAY_MS = 1_000;

export interface BrokerEnv {
  CODEX_OAUTH_BOOTSTRAP?: string;
}

export type CodexCredential = Readonly<{
  accessToken: string;
  accountId: string;
  fedramp: boolean;
  expiresAt: number;
  revision: number;
}>;

type StoredCredential = {
  version: 1;
  bootstrapFingerprint: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  fedramp: boolean;
  expiresAt: number;
  lastRefreshAt: number;
  revision: number;
  deadReason: string | null;
  refreshState: "ready" | "in_flight";
};

type BootstrapCredential = {
  fingerprint: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  fedramp: boolean;
  expiresAt: number;
};

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
};

type IdTokenClaims = {
  accountId?: string;
  fedramp?: boolean;
};

type RecoverRequest = {
  revision?: unknown;
};

export class CodexOAuthBroker extends DurableObject<BrokerEnv> {
  readonly #state: DurableObjectState;
  readonly #env: BrokerEnv;
  readonly #ready: Promise<void>;
  #credential: StoredCredential | undefined;
  #refresh: Promise<StoredCredential> | undefined;

  constructor(state: DurableObjectState, env: BrokerEnv) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    this.#ready = state.blockConcurrencyWhile(() => this.#initialize());
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready;
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ready: this.#credential !== undefined }, { status: 200 });
    }
    if (request.method === "POST" && url.pathname === "/v1/token") {
      return this.#serveToken(false);
    }
    if (request.method === "POST" && url.pathname === "/v1/recover") {
      const body = await readJson<RecoverRequest>(request, 1_024);
      if (!body || !validRevision(body.revision)) {
        return json({ error: "invalid_revision" }, { status: 400 });
      }
      const current = this.#credential;
      if (!current) return json({ error: "not_bootstrapped" }, { status: 503 });
      if (current.revision !== body.revision) return this.#serveToken(false);
      return this.#serveToken(true);
    }
    return json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.#ready;
    const current = this.#credential;
    if (!current || current.deadReason || !current.refreshToken) return;
    try {
      await this.#refreshCredential(current);
    } catch (error) {
      const failure = brokerFailure(error);
      console.warn(JSON.stringify({
        type: "codex_oauth.refresh_failed",
        code: failure.code,
        retryable: failure.status === 503,
      }));
      if (failure.status === 503) {
        await this.#state.storage.setAlarm(Date.now() + 60_000);
      }
    }
  }

  async #initialize(): Promise<void> {
    const [stored, bootstrap] = await Promise.all([
      this.#state.storage.get<StoredCredential>(STORAGE_KEY),
      parseBootstrap(this.#env.CODEX_OAUTH_BOOTSTRAP),
    ]);
    if (bootstrap && stored?.bootstrapFingerprint !== bootstrap.fingerprint) {
      const seeded = fromBootstrap(bootstrap);
      await this.#state.storage.put(STORAGE_KEY, seeded);
      this.#credential = seeded;
    } else if (stored) {
      if (stored.refreshState === "in_flight") {
        const dead = {
          ...stored,
          refreshState: "ready" as const,
          deadReason: "refresh_outcome_unknown",
        };
        await this.#state.storage.put(STORAGE_KEY, dead);
        this.#credential = dead;
      } else {
        this.#credential = stored;
      }
    }
    if (this.#credential) await this.#schedule(this.#credential);
  }

  async #serveToken(forceRefresh: boolean): Promise<Response> {
    const current = this.#credential;
    if (!current) return json({ error: "not_bootstrapped" }, { status: 503 });
    if (current.deadReason) {
      return json(
        { error: "credential_dead", reason: current.deadReason },
        { status: 422 },
      );
    }

    const now = Date.now();
    const needsRefresh = forceRefresh
      || (current.refreshToken !== ""
        && current.expiresAt <= now + REFRESH_EARLY_MS);
    if (!needsRefresh) {
      if (current.expiresAt <= now) {
        return json({ error: "credential_expired" }, { status: 503 });
      }
      return credentialResponse(current);
    }

    try {
      return credentialResponse(await this.#refreshCredential(current));
    } catch (error) {
      const failure = brokerFailure(error);
      const latest = this.#credential;
      if (!forceRefresh
        && failure.status === 503
        && latest
        && !latest.deadReason
        && latest.expiresAt > Date.now()) {
        return credentialResponse(latest);
      }
      return json(
        { error: failure.code },
        {
          status: failure.status,
          ...(failure.status === 503 ? { headers: { "retry-after": "5" } } : {}),
        },
      );
    }
  }

  #refreshCredential(rejected: StoredCredential): Promise<StoredCredential> {
    if (this.#refresh) return this.#refresh;
    const refresh = this.#refreshOnce(rejected).finally(() => {
      if (this.#refresh === refresh) this.#refresh = undefined;
    });
    this.#refresh = refresh;
    return refresh;
  }

  async #refreshOnce(rejected: StoredCredential): Promise<StoredCredential> {
    const current = this.#credential;
    if (!current) throw new BrokerFailure(503, "not_bootstrapped");
    if (current.revision !== rejected.revision) return current;
    if (current.deadReason) throw new BrokerFailure(422, "credential_dead");
    if (!current.refreshToken) throw new BrokerFailure(503, "refresh_token_unavailable");

    const claimed: StoredCredential = { ...current, refreshState: "in_flight" };
    try {
      await this.#state.storage.put(STORAGE_KEY, claimed);
    } catch {
      throw new BrokerFailure(503, "refresh_claim_failed");
    }
    this.#credential = claimed;

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: CODEX_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      await this.#markAmbiguous(claimed, "refresh_outcome_unknown");
      throw new BrokerFailure(422, "credential_dead");
    }

    let encoded: string;
    try {
      encoded = await readBoundedText(response, MAX_OAUTH_RESPONSE_BYTES);
    } catch {
      await this.#markAmbiguous(claimed, "refresh_outcome_unknown");
      throw new BrokerFailure(422, "credential_dead");
    }
    if (!response.ok) {
      const code = oauthErrorCode(encoded);
      if (response.status === 429) {
        try {
          await this.#restoreAfterSafeRejection(current);
        } catch {
          await this.#markAmbiguous(claimed, "refresh_state_restore_failed");
          throw new BrokerFailure(422, "credential_dead");
        }
        throw new BrokerFailure(503, "token_endpoint_rate_limited");
      }
      const reason = code ?? `token_endpoint_http_${response.status}`;
      await this.#markDead(claimed, reason);
      throw new BrokerFailure(422, "credential_dead");
    }

    let tokens: TokenResponse;
    try {
      tokens = JSON.parse(encoded) as TokenResponse;
    } catch {
      await this.#markAmbiguous(claimed, "refresh_outcome_unknown");
      throw new BrokerFailure(422, "credential_dead");
    }
    const accessToken = nonEmptyString(tokens.access_token);
    if (!accessToken) {
      await this.#markAmbiguous(claimed, "refresh_outcome_unknown");
      throw new BrokerFailure(422, "credential_dead");
    }
    const idClaims = idTokenClaims(nonEmptyString(tokens.id_token));
    const accountId = idClaims.accountId ?? current.accountId;
    if (accountId !== current.accountId) {
      await this.#markDead(claimed, "account_changed");
      throw new BrokerFailure(422, "credential_dead");
    }
    const expiresAt = jwtExpiration(accessToken)
      ?? expiresAtFromSeconds(tokens.expires_in)
      ?? undefined;
    if (!expiresAt || expiresAt <= Date.now()) {
      await this.#markAmbiguous(claimed, "refresh_outcome_unknown");
      throw new BrokerFailure(422, "credential_dead");
    }
    const next: StoredCredential = {
      ...claimed,
      accessToken,
      refreshToken: nonEmptyString(tokens.refresh_token) ?? current.refreshToken,
      accountId,
      fedramp: idClaims.fedramp ?? current.fedramp,
      expiresAt,
      lastRefreshAt: Date.now(),
      revision: current.revision + 1,
      deadReason: null,
      refreshState: "ready",
    };

    try {
      await this.#state.storage.put(STORAGE_KEY, next);
    } catch {
      await this.#markAmbiguous(next, "post_refresh_persist_failed");
      throw new BrokerFailure(422, "credential_dead");
    }
    this.#credential = next;
    await this.#schedule(next);
    console.log(JSON.stringify({
      type: "codex_oauth.refreshed",
      revision: next.revision,
      expires_at: new Date(next.expiresAt).toISOString(),
    }));
    return next;
  }

  async #markDead(current: StoredCredential, reason: string): Promise<void> {
    const dead = { ...current, refreshState: "ready" as const, deadReason: reason };
    this.#credential = dead;
    try {
      await this.#state.storage.put(STORAGE_KEY, dead);
    } catch {
      // The preceding durable in-flight marker still prevents replay after
      // an isolate restart.
    }
    console.error(JSON.stringify({ type: "codex_oauth.credential_dead", reason }));
  }

  async #markAmbiguous(current: StoredCredential, reason: string): Promise<void> {
    const dead = { ...current, refreshState: "ready" as const, deadReason: reason };
    this.#credential = dead;
    try {
      await this.#state.storage.put(STORAGE_KEY, dead);
    } catch {
      // The durable in-flight marker was committed before the refresh POST.
      // If this write also fails, a future isolate will fail it dead during
      // initialization instead of replaying the old refresh token.
    }
    console.error(JSON.stringify({ type: "codex_oauth.credential_dead", reason }));
  }

  async #restoreAfterSafeRejection(current: StoredCredential): Promise<void> {
    await this.#state.storage.put(STORAGE_KEY, current);
    this.#credential = current;
    await this.#state.storage.setAlarm(Date.now() + 60_000);
  }

  async #schedule(credential: StoredCredential): Promise<void> {
    if (!credential.refreshToken || credential.deadReason) return;
    const ttl = Math.max(0, credential.expiresAt - credential.lastRefreshAt);
    const slack = Math.max(REFRESH_EARLY_MS, Math.floor(ttl * 0.2));
    const at = Math.max(Date.now() + MIN_ALARM_DELAY_MS, credential.expiresAt - slack);
    await this.#state.storage.setAlarm(at);
  }
}

class BrokerFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function brokerFailure(error: unknown): BrokerFailure {
  return error instanceof BrokerFailure
    ? error
    : new BrokerFailure(503, "broker_internal_error");
}

async function parseBootstrap(raw: string | undefined): Promise<BootstrapCredential | undefined> {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CODEX_OAUTH_BOOTSTRAP is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("CODEX_OAUTH_BOOTSTRAP must be an object");
  const accessToken = nonEmptyString(parsed.access_token);
  const accountId = nonEmptyString(parsed.account_id);
  const refreshToken = nonEmptyString(parsed.refresh_token) ?? "";
  if (!accessToken || !accountId) {
    throw new Error("CODEX_OAUTH_BOOTSTRAP requires access_token and account_id");
  }
  const expiresAt = parseExpiry(parsed.expires_at) ?? jwtExpiration(accessToken);
  if (!expiresAt) {
    throw new Error("CODEX_OAUTH_BOOTSTRAP requires expires_at or a JWT access token with exp");
  }
  const canonical = JSON.stringify({
    accessToken,
    refreshToken,
    accountId,
    fedramp: parsed.fedramp === true,
    expiresAt,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return {
    fingerprint: hex(new Uint8Array(digest)),
    accessToken,
    refreshToken,
    accountId,
    fedramp: parsed.fedramp === true,
    expiresAt,
  };
}

function fromBootstrap(bootstrap: BootstrapCredential): StoredCredential {
  return {
    version: 1,
    bootstrapFingerprint: bootstrap.fingerprint,
    accessToken: bootstrap.accessToken,
    refreshToken: bootstrap.refreshToken,
    accountId: bootstrap.accountId,
    fedramp: bootstrap.fedramp,
    expiresAt: bootstrap.expiresAt,
    lastRefreshAt: Date.now(),
    revision: 0,
    deadReason: null,
    refreshState: "ready",
  };
}

function credentialResponse(credential: StoredCredential): Response {
  const body: CodexCredential = {
    accessToken: credential.accessToken,
    accountId: credential.accountId,
    fedramp: credential.fedramp,
    expiresAt: credential.expiresAt,
    revision: credential.revision,
  };
  return json(body, { status: 200 });
}

function json(body: unknown, init: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
      ...init.headers,
    },
  });
}

async function readJson<T>(request: Request, limit: number): Promise<T | undefined> {
  try {
    return JSON.parse(await readBoundedText(request, limit)) as T;
  } catch {
    return undefined;
  }
}

async function readBoundedText(message: Request | Response, limit: number): Promise<string> {
  if (!message.body) return "";
  const reader = message.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BrokerFailure(503, "response_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function oauthErrorCode(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    if (!isRecord(value)) return undefined;
    const direct = nonEmptyString(value.error);
    if (direct) return safeCode(direct);
    if (isRecord(value.error)) return safeCode(nonEmptyString(value.error.code));
    return undefined;
  } catch {
    return undefined;
  }
}

function safeCode(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function idTokenClaims(token: string | undefined): IdTokenClaims {
  const claims = jwtPayload(token);
  if (!claims) return {};
  const auth = claims["https://api.openai.com/auth"];
  if (!isRecord(auth)) return {};
  const accountId = nonEmptyString(auth.chatgpt_account_id);
  return {
    ...(accountId ? { accountId } : {}),
    ...(typeof auth.chatgpt_account_is_fedramp === "boolean"
      ? { fedramp: auth.chatgpt_account_is_fedramp }
      : {}),
  };
}

function jwtExpiration(token: string): number | undefined {
  const claims = jwtPayload(token);
  return typeof claims?.exp === "number" && Number.isFinite(claims.exp)
    ? claims.exp * 1_000
    : undefined;
}

function jwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const encoded = token?.split(".")[1];
  if (!encoded) return undefined;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function expiresAtFromSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Date.now() + value * 1_000;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
