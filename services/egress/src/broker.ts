import { DurableObject } from "cloudflare:workers";

import {
  CredentialVault,
  type CredentialVaultEnv,
  type EncryptedEnvelope,
} from "./credential-vault";

const STATE_KEY = "credential-state";
const TOKEN_ENDPOINT_PATH = "/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const LOGIN_TTL_MS = 15 * 60_000;
const REFRESH_EARLY_MS = 5 * 60_000;
const DEFAULT_REFRESH_BACKOFF_MS = 60_000;
const MAX_REFRESH_BACKOFF_MS = 15 * 60_000;
const MAX_REFRESH_BACKOFF_ATTEMPT = 5;
const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024;
const SUBJECT = /^[A-Za-z0-9_-]{43,128}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBJECT_DIRECTORY_PREFIX = "agent-subject-v1:";
const SUBJECT_TOMBSTONE_PREFIX = "!deleted:";

export interface BrokerEnv extends CredentialVaultEnv {
  AGENT_SUBJECTS: DurableObjectNamespace<AgentSubjectDirectory>;
  CHATGPT_ISSUER?: string;
  ALLOW_LOCAL_CREDENTIAL_CLAIM?: string;
  LOCAL_CHATGPT_BOOTSTRAP?: string;
}

export type UserCredentialSnapshot = Readonly<{
  kind: "openai" | "chatgpt";
  secret: string;
  accountId?: string;
  fedramp?: boolean;
  expiresAt?: number;
  revision: number;
}>;

type ApiKeyCredential = { secret: string; createdAt: number; revision: number };
type ChatGptCredential = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  fedramp: boolean;
  expiresAt: number;
  revision: number;
  refreshState: "ready" | "in_flight";
  refreshAfter?: number;
  refreshAttempts?: number;
  deadReason: string | null;
};
type PendingLogin = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  pollAfterMs: number;
  nextPollAt: number;
};
type CredentialState = {
  version: 1;
  active: "openai" | "chatgpt" | null;
  openai?: ApiKeyCredential;
  chatgpt?: ChatGptCredential;
  login?: PendingLogin;
};
type StoredRow = { envelope: EncryptedEnvelope };

export class AgentSubjectDirectory extends DurableObject<BrokerEnv> {
  readonly #state: DurableObjectState;
  readonly #subject: string | undefined;

  constructor(state: DurableObjectState, env: BrokerEnv) {
    super(state, env);
    this.#state = state;
    this.#subject = state.id.name?.startsWith(SUBJECT_DIRECTORY_PREFIX)
      ? state.id.name.slice(SUBJECT_DIRECTORY_PREFIX.length)
      : undefined;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      return this.#dispatch(request);
    }
    const body = await readJson(request, 2_048);
    if (!body) return jsonError(400, "invalid_json");
    return this.#dispatch(request, body);
  }

  async #dispatch(
    request: Request,
    parsedBody?: Record<string, unknown>,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      return json({ ready: true }, 200);
    }
    const body = parsedBody ?? await readJson(request, 2_048);
    if (!body) return jsonError(400, "invalid_json");
    const subject = stringField(body, "subject");
    if ((url.pathname === "/v1/bind" || url.pathname === "/v1/unbind"
        || url.pathname === "/v1/resolve")
      && (!SUBJECT.test(subject ?? "") || subject !== this.#subject)) {
      return jsonError(400, "invalid_subject");
    }
    if (request.method === "POST" && url.pathname === "/v1/bind") {
      const userId = stringField(body, "user_id");
      if (!USER_ID.test(userId ?? "")) return jsonError(400, "invalid_user_id");
      const result = await this.#state.storage.transaction(async (transaction) => {
        const key = `subject:${subject}`;
        const current = await transaction.get<string>(key);
        if (subjectTombstoneOwner(current) !== undefined) return "deleted" as const;
        if (current && current !== userId) return "conflict" as const;
        if (!current) await transaction.put(key, userId!);
        return current ? "unchanged" as const : "bound" as const;
      });
      if (result === "deleted") return jsonError(410, "subject_deleted");
      if (result === "conflict") return jsonError(409, "subject_already_bound");
      return json({ status: result }, 200);
    }
    if (request.method === "POST" && url.pathname === "/v1/unbind") {
      const userId = stringField(body, "user_id");
      if (!USER_ID.test(userId ?? "")) return jsonError(400, "invalid_user_id");
      const removed = await this.#tombstoneSubject(subject!, userId!);
      if (removed === "mismatch") return jsonError(409, "subject_owner_mismatch");
      return new Response(null, { status: 204, headers: noStoreHeaders() });
    }
    if (request.method === "POST" && url.pathname === "/v1/resolve") {
      const retained = await this.#state.storage.get<string>(`subject:${subject}`);
      const deletedUserId = subjectTombstoneOwner(retained);
      return retained && deletedUserId === undefined
        ? json({ user_id: retained }, 200)
        : jsonError(404, "subject_not_bound");
    }
    return jsonError(404, "not_found");
  }

  async #tombstoneSubject(subject: string, userId: string): Promise<true | "mismatch"> {
    return this.#state.storage.transaction(async (transaction) => {
      const key = `subject:${subject}`;
      const current = await transaction.get<string>(key);
      const retainedOwner = subjectTombstoneOwner(current);
      if ((retainedOwner ?? current) && (retainedOwner ?? current) !== userId) {
        return "mismatch" as const;
      }
      await transaction.put(key, subjectTombstone(userId));
      return true;
    });
  }

}

function subjectTombstone(userId: string): string {
  return `${SUBJECT_TOMBSTONE_PREFIX}${userId}`;
}

function subjectTombstoneOwner(value: string | undefined): string | undefined {
  return value?.startsWith(SUBJECT_TOMBSTONE_PREFIX)
    ? value.slice(SUBJECT_TOMBSTONE_PREFIX.length)
    : undefined;
}

export class UserCredentialBroker extends DurableObject<BrokerEnv> {
  readonly #state: DurableObjectState;
  readonly #env: BrokerEnv;
  readonly #vault: CredentialVault;
  readonly #ready: Promise<void>;
  #credentials: CredentialState = { version: 1, active: null };
  #tail: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: BrokerEnv) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    this.#vault = new CredentialVault(env, `user/${state.id.toString()}`);
    this.#ready = state.blockConcurrencyWhile(() => this.#initialize());
  }

  fetch(request: Request): Promise<Response> {
    return this.#exclusive(async () => {
      await this.#ready;
      return this.#dispatch(request);
    });
  }

  alarm(): Promise<void> {
    return this.#exclusive(async () => {
      await this.#ready;
      if (this.#credentials.login && this.#credentials.login.expiresAt <= Date.now()) {
        delete this.#credentials.login;
        await this.#persist();
      }
      const credential = this.#credentials.chatgpt;
      if (credential && !credential.deadReason && credential.refreshToken
        && credential.expiresAt <= Date.now() + REFRESH_EARLY_MS
        && (credential.refreshAfter ?? 0) <= Date.now()) {
        try {
          await this.#refreshChatGpt(credential);
        } catch (error) {
          console.warn(JSON.stringify({
            type: "user_credential.refresh_failed",
            code: failure(error).code,
          }));
        }
      }
      await this.#schedule();
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #initialize(): Promise<void> {
    const row = await this.#state.storage.get<StoredRow>(STATE_KEY);
    if (!row) return;
    const opened = await this.#vault.open<CredentialState>(row.envelope);
    const quarantined = this.#installRestoredState(opened.value);
    if (quarantined || opened.reseal) {
      await this.#persist();
    }
    await this.#schedule();
  }

  async #dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return json({ ready: true }, 200);
      }
      if (request.method === "GET" && url.pathname === "/v1/status") {
        return json(this.#publicStatus(), 200);
      }
      if (request.method === "PUT" && url.pathname === "/v1/openai-key") {
        const body = await readJson(request, 16 * 1024);
        const secret = stringField(body, "api_key")?.trim();
        if (!secret || secret.length > 8_192 || /[\u0000-\u001f\u007f]/.test(secret)) {
          return jsonError(400, "invalid_openai_api_key");
        }
        this.#credentials.openai = {
          secret,
          createdAt: Date.now(),
          revision: (this.#credentials.openai?.revision ?? -1) + 1,
        };
        this.#credentials.active = "openai";
        await this.#persist();
        return new Response(null, { status: 204, headers: noStoreHeaders() });
      }
      if (request.method === "DELETE" && url.pathname === "/v1/openai-key") {
        delete this.#credentials.openai;
        if (this.#credentials.active === "openai") {
          this.#credentials.active = this.#credentials.chatgpt ? "chatgpt" : null;
        }
        await this.#persist();
        return new Response(null, { status: 204, headers: noStoreHeaders() });
      }
      if (request.method === "POST" && url.pathname === "/v1/chatgpt/login/start") {
        const login = await this.#startLogin();
        this.#credentials.login = login;
        await this.#persist();
        await this.#schedule();
        return json(publicLogin(login), 200);
      }
      if (request.method === "POST" && url.pathname === "/v1/chatgpt/login/status") {
        return json(await this.#loginStatus(), 200);
      }
      if (request.method === "DELETE" && url.pathname === "/v1/chatgpt") {
        delete this.#credentials.chatgpt;
        delete this.#credentials.login;
        if (this.#credentials.active === "chatgpt") {
          this.#credentials.active = this.#credentials.openai ? "openai" : null;
        }
        await this.#persist();
        await this.#schedule();
        return new Response(null, { status: 204, headers: noStoreHeaders() });
      }
      if (request.method === "POST" && url.pathname === "/v1/chatgpt/local-claim") {
        await this.#claimLocalBootstrap();
        return json(this.#publicStatus(), 200);
      }
      if (request.method === "POST" && url.pathname === "/v1/credential") {
        const body = await readJson(request, 1_024);
        const recover = body?.recover === true;
        const revision = numberField(body, "revision");
        return json(await this.#credential(recover, revision), 200);
      }
      return jsonError(404, "not_found");
    } catch (error) {
      const problem = failure(error);
      // A failed seal or storage write must never leave an uncommitted
      // credential usable from this isolate's memory. Reload the last durable
      // encrypted state, or fail closed if it cannot be opened.
      await this.#restoreDurableState();
      return jsonError(problem.status, problem.code);
    }
  }

  #publicStatus(): Record<string, unknown> {
    const login = this.#credentials.login;
    return {
      ready: this.#credentials.active !== null,
      active: this.#credentials.active,
      openai: { connected: Boolean(this.#credentials.openai) },
      chatgpt: {
        connected: Boolean(this.#credentials.chatgpt && !this.#credentials.chatgpt.deadReason),
        ...(this.#credentials.chatgpt?.accountId
          ? { account_id: this.#credentials.chatgpt.accountId }
          : {}),
        ...(login ? { login: publicLogin(login) } : {}),
      },
    };
  }

  async #credential(recover: boolean, revision: number | undefined): Promise<UserCredentialSnapshot> {
    if (this.#credentials.active === "openai" && this.#credentials.openai) {
      return {
        kind: "openai",
        secret: this.#credentials.openai.secret,
        revision: this.#credentials.openai.revision,
      };
    }
    const current = this.#credentials.chatgpt;
    if (this.#credentials.active !== "chatgpt" || !current) {
      throw new BrokerFailure(404, "credential_not_configured");
    }
    if (current.deadReason) throw new BrokerFailure(422, "chatgpt_credential_dead");
    const now = Date.now();
    const refreshNeeded = recover
      ? revision === current.revision
      : current.expiresAt <= now + REFRESH_EARLY_MS;
    if (refreshNeeded && (current.refreshAfter ?? 0) > now) {
      if (recover || current.expiresAt <= now) {
        throw new BrokerFailure(503, "chatgpt_refresh_rate_limited");
      }
      return {
        kind: "chatgpt",
        secret: current.accessToken,
        accountId: current.accountId,
        fedramp: current.fedramp,
        expiresAt: current.expiresAt,
        revision: current.revision,
      };
    }
    let credential = current;
    if (refreshNeeded) {
      try {
        credential = await this.#refreshChatGpt(current);
      } catch (error) {
        if (recover || !(error instanceof BrokerFailure)
          || error.code !== "chatgpt_refresh_rate_limited"
          || current.expiresAt <= Date.now()) {
          throw error;
        }
      }
    }
    if (credential.expiresAt <= Date.now()) {
      throw new BrokerFailure(503, "chatgpt_credential_expired");
    }
    return {
      kind: "chatgpt",
      secret: credential.accessToken,
      accountId: credential.accountId,
      fedramp: credential.fedramp,
      expiresAt: credential.expiresAt,
      revision: credential.revision,
    };
  }

  async #startLogin(): Promise<PendingLogin> {
    const environment = this.#env.ENVIRONMENT?.trim().toLowerCase();
    if (this.#env.ALLOW_LOCAL_CREDENTIAL_CLAIM === "true"
      && (environment === "development" || environment === "local")) {
      throw new BrokerFailure(409, "local_credential_claim_required");
    }
    const issuer = issuerUrl(this.#env);
    const response = await providerFetch(new URL("api/accounts/deviceauth/usercode", issuer), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new BrokerFailure(503, "chatgpt_login_start_failed");
    }
    const value = await providerJson(response);
    const deviceAuthId = stringField(value, "device_auth_id");
    const userCode = stringField(value, "user_code") ?? stringField(value, "usercode");
    const interval = positiveNumber(value.interval) ?? positiveNumberString(value.interval) ?? 5;
    if (!deviceAuthId || !userCode) throw new BrokerFailure(503, "invalid_chatgpt_login_response");
    return {
      deviceAuthId,
      userCode,
      verificationUrl: new URL("codex/device", issuer).href,
      expiresAt: Date.now() + LOGIN_TTL_MS,
      pollAfterMs: Math.max(1_000, Math.min(60_000, interval * 1_000)),
      nextPollAt: Date.now(),
    };
  }

  async #loginStatus(): Promise<Record<string, unknown>> {
    const login = this.#credentials.login;
    if (!login) {
      if (this.#credentials.chatgpt && !this.#credentials.chatgpt.deadReason) {
        return { state: "authenticated", account_id: this.#credentials.chatgpt.accountId };
      }
      return { state: "not_started" };
    }
    if (login.expiresAt <= Date.now()) {
      delete this.#credentials.login;
      await this.#persist();
      return { state: "expired" };
    }
    if (login.nextPollAt > Date.now()) return publicLogin(login);

    const issuer = issuerUrl(this.#env);
    const response = await providerFetch(new URL("api/accounts/deviceauth/token", issuer), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode }),
    });
    if (response.status === 403 || response.status === 404) {
      await cancelResponseBody(response);
      login.nextPollAt = Date.now() + login.pollAfterMs;
      await this.#persist();
      return publicLogin(login);
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new BrokerFailure(503, "chatgpt_login_poll_failed");
    }
    const code = await providerJson(response);
    const authorizationCode = stringField(code, "authorization_code");
    const codeVerifier = stringField(code, "code_verifier");
    if (!authorizationCode || !codeVerifier || !stringField(code, "code_challenge")) {
      throw new BrokerFailure(503, "invalid_chatgpt_login_response");
    }
    const tokens = await exchangeAuthorizationCode(issuer, authorizationCode, codeVerifier);
    this.#credentials.chatgpt = credentialFromTokens(tokens, undefined, 0);
    this.#credentials.active = "chatgpt";
    delete this.#credentials.login;
    await this.#persist();
    await this.#schedule();
    return { state: "authenticated", account_id: this.#credentials.chatgpt.accountId };
  }

  async #claimLocalBootstrap(): Promise<void> {
    const environment = this.#env.ENVIRONMENT?.trim().toLowerCase();
    const local = environment === "development" || environment === "local" || environment === "test";
    if (!local || this.#env.ALLOW_LOCAL_CREDENTIAL_CLAIM !== "true") {
      throw new BrokerFailure(404, "not_found");
    }
    const raw = this.#env.LOCAL_CHATGPT_BOOTSTRAP?.trim();
    if (!raw) throw new BrokerFailure(503, "local_chatgpt_bootstrap_unavailable");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new BrokerFailure(503, "invalid_local_chatgpt_bootstrap"); }
    if (!isRecord(parsed)) throw new BrokerFailure(503, "invalid_local_chatgpt_bootstrap");
    const accessToken = stringField(parsed, "access_token");
    const accountId = stringField(parsed, "account_id") ?? idTokenClaims(stringField(parsed, "id_token")).accountId;
    const expiresAt = parseExpiry(parsed.expires_at) ?? jwtExpiration(accessToken);
    if (!accessToken || !accountId || !expiresAt || expiresAt <= Date.now()) {
      throw new BrokerFailure(503, "invalid_local_chatgpt_bootstrap");
    }
    this.#credentials.chatgpt = {
      accessToken,
      refreshToken: stringField(parsed, "refresh_token") ?? "",
      accountId,
      fedramp: parsed.fedramp === true,
      expiresAt,
      revision: (this.#credentials.chatgpt?.revision ?? -1) + 1,
      refreshState: "ready",
      deadReason: null,
    };
    this.#credentials.active = "chatgpt";
    delete this.#credentials.login;
    await this.#persist();
    await this.#schedule();
  }

  async #refreshChatGpt(current: ChatGptCredential): Promise<ChatGptCredential> {
    if (!current.refreshToken) throw new BrokerFailure(503, "chatgpt_refresh_unavailable");
    const claimed = { ...current, refreshState: "in_flight" as const };
    this.#credentials.chatgpt = claimed;
    await this.#persist();
    let response: Response;
    try {
      const issuer = issuerUrl(this.#env);
      response = await providerFetch(new URL(TOKEN_ENDPOINT_PATH.slice(1), issuer), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CODEX_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        }),
      });
    } catch {
      await this.#markDead(claimed, "refresh_outcome_unknown");
      throw new BrokerFailure(422, "chatgpt_credential_dead");
    }
    if (!response.ok) {
      if (response.status === 429) {
        const now = Date.now();
        const refreshAttempts = nextRefreshAttempt(current.refreshAttempts);
        const refreshAfter = now + retryAfterDelayMs(
          response.headers.get("retry-after"),
          now,
          refreshAttempts,
        );
        this.#credentials.chatgpt = {
          ...current,
          refreshState: "ready",
          refreshAfter,
          refreshAttempts,
        };
        await finishRateLimitedRefresh(
          response,
          () => this.#persist(),
          () => this.#schedule(),
        );
        throw new BrokerFailure(503, "chatgpt_refresh_rate_limited");
      }
      await cancelResponseBody(response);
      await this.#markDead(claimed, `token_endpoint_http_${response.status}`);
      throw new BrokerFailure(422, "chatgpt_credential_dead");
    }
    try {
      const tokens = await providerJson(response);
      const next = credentialFromTokens(tokens, current, current.revision + 1);
      if (next.accountId !== current.accountId) {
        await this.#markDead(claimed, "account_changed");
        throw new BrokerFailure(422, "chatgpt_credential_dead");
      }
      this.#credentials.chatgpt = next;
      await this.#persist();
      await this.#schedule();
      return next;
    } catch (error) {
      if (error instanceof BrokerFailure && error.code === "chatgpt_credential_dead") throw error;
      await this.#markDead(claimed, "refresh_outcome_unknown");
      throw new BrokerFailure(422, "chatgpt_credential_dead");
    }
  }

  async #markDead(current: ChatGptCredential, reason: string): Promise<void> {
    this.#credentials.chatgpt = { ...current, refreshState: "ready", deadReason: reason };
    if (this.#credentials.active === "chatgpt") {
      this.#credentials.active = this.#credentials.openai ? "openai" : null;
    }
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await this.#state.storage.put(STATE_KEY, {
      envelope: await this.#vault.seal(this.#credentials),
    } satisfies StoredRow);
  }

  async #restoreDurableState(): Promise<void> {
    try {
      const row = await this.#state.storage.get<StoredRow>(STATE_KEY);
      if (!row) {
        this.#credentials = { version: 1, active: null };
        return;
      }
      const opened = await this.#vault.open<CredentialState>(row.envelope);
      this.#installRestoredState(opened.value);
    } catch {
      this.#credentials = { version: 1, active: null };
    }
  }

  #installRestoredState(restored: CredentialState): boolean {
    this.#credentials = restored;
    const chatgpt = restored.chatgpt;
    if (chatgpt?.refreshState !== "in_flight") return false;
    chatgpt.refreshState = "ready";
    chatgpt.deadReason = "refresh_outcome_unknown";
    return true;
  }

  async #schedule(): Promise<void> {
    const times: number[] = [];
    if (this.#credentials.login) times.push(this.#credentials.login.expiresAt);
    const chatgpt = this.#credentials.chatgpt;
    if (chatgpt?.refreshToken && !chatgpt.deadReason) {
      times.push(Math.max(
        Date.now() + 1_000,
        chatgpt.expiresAt - REFRESH_EARLY_MS,
        chatgpt.refreshAfter ?? 0,
      ));
    }
    if (times.length) await this.#state.storage.setAlarm(Math.min(...times));
    else await this.#state.storage.deleteAlarm();
  }
}

export async function finishRateLimitedRefresh(
  response: Response,
  persist: () => Promise<void>,
  schedule: () => Promise<void>,
): Promise<void> {
  try {
    await persist();
    await schedule();
  } finally {
    await cancelResponseBody(response);
  }
}

export function retryAfterDelayMs(
  value: string | null,
  now = Date.now(),
  fallbackAttempt = 1,
  jitter = Math.random(),
): number {
  const candidate = value?.trim() ?? "";
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(candidate);
  const seconds = numeric ? Number(candidate) : Number.NaN;
  const parsed = numeric
    ? Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Number.NaN
    : candidate ? Date.parse(candidate) - now : Number.NaN;
  if (!Number.isFinite(parsed)) {
    const attempt = Number.isSafeInteger(fallbackAttempt) && fallbackAttempt > 0
      ? Math.min(MAX_REFRESH_BACKOFF_ATTEMPT, fallbackAttempt)
      : 1;
    const ceiling = Math.min(
      MAX_REFRESH_BACKOFF_MS,
      DEFAULT_REFRESH_BACKOFF_MS * 2 ** (attempt - 1),
    );
    const boundedJitter = Number.isFinite(jitter) ? Math.max(0, Math.min(1, jitter)) : 0.5;
    return Math.round(ceiling / 2 + ceiling / 2 * boundedJitter);
  }
  return Math.max(1_000, Math.min(MAX_REFRESH_BACKOFF_MS, parsed));
}

function nextRefreshAttempt(previous: number | undefined): number {
  const attempt = typeof previous === "number" && Number.isSafeInteger(previous) && previous >= 0
    ? previous + 1
    : 1;
  return Math.min(MAX_REFRESH_BACKOFF_ATTEMPT, attempt);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Response disposal is best-effort. */ }
}

class BrokerFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function failure(error: unknown): BrokerFailure {
  return error instanceof BrokerFailure ? error : new BrokerFailure(503, "credential_broker_failed");
}

function publicLogin(login: PendingLogin): Record<string, unknown> {
  return {
    state: "pending",
    verification_url: login.verificationUrl,
    user_code: login.userCode,
    expires_at: login.expiresAt,
    poll_after_ms: Math.max(0, login.nextPollAt - Date.now()),
  };
}

function issuerUrl(env: BrokerEnv): URL {
  const raw = env.CHATGPT_ISSUER?.trim() || "https://auth.openai.com/";
  const issuer = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  const environment = env.ENVIRONMENT?.trim().toLowerCase();
  const local = environment === "development" || environment === "local" || environment === "test";
  if (issuer.username || issuer.password || issuer.search || issuer.hash
    || (!local && (issuer.protocol !== "https:" || issuer.hostname !== "auth.openai.com"))
    || (local && issuer.protocol !== "https:" && !(issuer.protocol === "http:"
      && (issuer.hostname === "127.0.0.1" || issuer.hostname === "localhost")))) {
    throw new BrokerFailure(503, "invalid_chatgpt_issuer");
  }
  return issuer;
}

async function exchangeAuthorizationCode(
  issuer: URL,
  code: string,
  verifier: string,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: new URL("deviceauth/callback", issuer).href,
    client_id: CODEX_CLIENT_ID,
    code_verifier: verifier,
  });
  const response = await providerFetch(new URL("oauth/token", issuer), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new BrokerFailure(503, "chatgpt_token_exchange_failed");
  }
  return providerJson(response);
}

function credentialFromTokens(
  tokens: Record<string, unknown>,
  previous: ChatGptCredential | undefined,
  revision: number,
): ChatGptCredential {
  const accessToken = stringField(tokens, "access_token");
  const claims = idTokenClaims(stringField(tokens, "id_token"));
  const accountId = claims.accountId ?? previous?.accountId;
  const expiresAt = jwtExpiration(accessToken)
    ?? (positiveNumber(tokens.expires_in) ? Date.now() + positiveNumber(tokens.expires_in)! * 1_000 : undefined);
  if (!accessToken || !accountId || !expiresAt || expiresAt <= Date.now()) {
    throw new BrokerFailure(503, "invalid_chatgpt_token_response");
  }
  return {
    accessToken,
    refreshToken: stringField(tokens, "refresh_token") ?? previous?.refreshToken ?? "",
    accountId,
    fedramp: claims.fedramp ?? previous?.fedramp ?? false,
    expiresAt,
    revision,
    refreshState: "ready",
    deadReason: null,
  };
}

function idTokenClaims(token: string | undefined): { accountId?: string; fedramp?: boolean } {
  const claims = jwtPayload(token);
  const auth = claims?.["https://api.openai.com/auth"];
  if (!isRecord(auth)) return {};
  const accountId = stringField(auth, "chatgpt_account_id");
  return {
    ...(accountId ? { accountId } : {}),
    ...(typeof auth.chatgpt_account_is_fedramp === "boolean"
      ? { fedramp: auth.chatgpt_account_is_fedramp }
      : {}),
  };
}

function jwtExpiration(token: string | undefined): number | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1_000 : undefined;
}

function jwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const encoded = token?.split(".")[1];
  if (!encoded) return undefined;
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : undefined;
  } catch { return undefined; }
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

async function providerFetch(url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch { throw new BrokerFailure(503, "chatgpt_provider_unavailable"); }
}

async function providerJson(response: Response): Promise<Record<string, unknown>> {
  const text = await readBoundedText(response, MAX_PROVIDER_RESPONSE_BYTES);
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error();
    return value;
  } catch { throw new BrokerFailure(503, "invalid_chatgpt_provider_response"); }
}

async function readJson(request: Request, limit: number): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readBoundedText(request, limit));
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}

async function readBoundedText(message: Request | Response, limit: number): Promise<string> {
  if (!message.body) return "";
  const reader = message.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new BrokerFailure(413, "body_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" && value[key].trim()
    ? value[key] as string
    : undefined;
}
function numberField(value: unknown, key: string): number | undefined {
  return isRecord(value) && Number.isSafeInteger(value[key]) ? value[key] as number : undefined;
}
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function positiveNumberString(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  return positiveNumber(Number(value));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function noStoreHeaders(): Record<string, string> {
  return { "cache-control": "no-store", pragma: "no-cache" };
}
function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: noStoreHeaders() });
}
function jsonError(status: number, error: string): Response {
  return json({ error }, status);
}
