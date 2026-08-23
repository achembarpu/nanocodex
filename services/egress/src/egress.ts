import {
  AgentSubjectDirectory,
  type BrokerEnv,
  UserCredentialBroker,
  type UserCredentialSnapshot,
} from "./broker";

export { AgentSubjectDirectory, UserCredentialBroker } from "./broker";

const SUBJECT_DIRECTORY_NAME = "agent-subjects-v1";
const SUBJECT = /^[A-Za-z0-9_-]{43,128}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBJECT_HEADER = "x-nanocodex-subject";
const PROVIDER_PLACEHOLDER = "Bearer NANOCODEX_PROVIDER_CREDENTIAL";
const MODEL_STATUS_PATH = "/.well-known/nanocodex/model-status";
const BROKER_READINESS_PATH = "/.well-known/nanocodex/broker-readiness";
const MAX_CONTROL_BODY_BYTES = 16 * 1024;
const MAX_BROKER_RESPONSE_BYTES = 4 * 1024;
const MAX_MODEL_BODY_BYTES = 32 * 1024 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface EgressEnv extends BrokerEnv {
  USER_CREDENTIALS: DurableObjectNamespace<UserCredentialBroker>;
  AGENT_SUBJECTS: DurableObjectNamespace<AgentSubjectDirectory>;
  CHATGPT_EGRESS?: DurableObjectNamespace;
  CODEX_RELAY_URL?: string;
  ALLOW_INSECURE_LOOPBACK_RELAY?: string;
  NANOCODEX_BROKER_PROBE_TOKEN?: string;
}

type ModelOperation = Readonly<{
  id: "responses" | "search" | "image-generation" | "image-edit";
  method: "GET" | "POST";
  path: `/v1/${string}`;
  websocket: boolean;
  openai: `https://${string}`;
  chatgpt: `https://${string}`;
}>;

const OPERATIONS: readonly ModelOperation[] = [
  {
    id: "responses",
    method: "GET",
    path: "/v1/responses",
    websocket: true,
    openai: "https://api.openai.com/v1/responses",
    chatgpt: "https://chatgpt.com/backend-api/codex/responses",
  },
  {
    id: "search",
    method: "POST",
    path: "/v1/search",
    websocket: false,
    openai: "https://api.openai.com/v1/alpha/search",
    chatgpt: "https://chatgpt.com/backend-api/codex/alpha/search",
  },
  {
    id: "image-generation",
    method: "POST",
    path: "/v1/images/generations",
    websocket: false,
    openai: "https://api.openai.com/v1/images/generations",
    chatgpt: "https://chatgpt.com/backend-api/codex/images/generations",
  },
  {
    id: "image-edit",
    method: "POST",
    path: "/v1/images/edits",
    websocket: false,
    openai: "https://api.openai.com/v1/images/edits",
    chatgpt: "https://chatgpt.com/backend-api/codex/images/edits",
  },
];

export default {
  fetch(request: Request, env: EgressEnv, ctx: ExecutionContext): Promise<Response> {
    return handleEgress(request, env, ctx);
  },
} satisfies ExportedHandler<EgressEnv>;

export async function handleEgress(
  request: Request,
  env: EgressEnv,
  _ctx?: Pick<ExecutionContext, "waitUntil">,
  upstreamFetch: typeof fetch = fetch,
  diagnostics?: Readonly<{ upstreamException(error: Readonly<{ name: string }>): void }>,
): Promise<Response> {
  const started = Date.now();
  let url: URL;
  try { url = new URL(request.url); } catch { return jsonError(400, "invalid_url"); }
  if (url.username || url.password || url.search || url.hash) return jsonError(403, "destination_denied");

  if (url.pathname.startsWith("/subjects/") || url.pathname.startsWith("/users/")) {
    return handleControl(request, url, env);
  }
  if (url.pathname === BROKER_READINESS_PATH) return handleReadiness(request, env);
  if (url.pathname === MODEL_STATUS_PATH) return handleModelStatus(request, env);

  const operation = OPERATIONS.find((candidate) => (
    candidate.method === request.method && candidate.path === url.pathname
      && url.protocol === "https:" && url.hostname === "nanocodex.internal" && !url.port
  ));
  if (!operation) return auditedError(403, "destination_denied", request, url, undefined, started);
  const subject = request.headers.get(SUBJECT_HEADER);
  if (!subject || !SUBJECT.test(subject)) {
    return auditedError(403, "agent_subject_required", request, url, operation.id, started);
  }
  if (request.headers.get("authorization") !== PROVIDER_PLACEHOLDER) {
    return auditedError(403, "credential_placeholder_mismatch", request, url, operation.id, started);
  }
  if (request.headers.has("chatgpt-account-id") || request.headers.has("x-openai-fedramp")
    || request.headers.has("originator")) {
    return auditedError(403, "provider_header_forbidden", request, url, operation.id, started);
  }
  if (operation.websocket) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      || request.headers.get("openai-beta")?.toLowerCase()
        !== "responses_websockets=2026-02-06") {
      return auditedError(403, "required_header_mismatch", request, url, operation.id, started);
    }
  } else if (request.headers.get("content-type")?.toLowerCase() !== "application/json") {
    return auditedError(403, "required_header_mismatch", request, url, operation.id, started);
  }

  try {
    const userId = await resolveSubject(env, subject);
    let credential = await resolveCredential(env, userId, false);
    const body = await replayableBody(request, operation);
    let upstream = await fetchUpstream(
      env,
      userId,
      credential,
      buildUpstreamRequest(request, env, operation, credential, body),
      upstreamFetch,
    );
    let recovered = false;
    if (upstream.status === 401 && credential.kind === "chatgpt") {
      await upstream.body?.cancel();
      credential = await resolveCredential(env, userId, true, credential.revision);
      upstream = await fetchUpstream(
        env,
        userId,
        credential,
        buildUpstreamRequest(request, env, operation, credential, body),
        upstreamFetch,
      );
      recovered = true;
    }
    if (REDIRECT_STATUS.has(upstream.status)) {
      await upstream.body?.cancel();
      return auditedError(502, "upstream_redirect_blocked", request, url, operation.id, started);
    }
    if (upstream.status >= 400) {
      const status = upstream.status;
      await upstream.body?.cancel();
      return auditedError(status === 429 ? 503 : 502, "upstream_rejected", request, url, operation.id, started);
    }
    audit("allow", request, url, operation.id, started, { status: upstream.status, recovered });
    return sanitizeUpstreamResponse(upstream);
  } catch (error) {
    const problem = egressFailure(error);
    if (!(error instanceof EgressFailure)) {
      const detail = { name: error instanceof Error ? error.name : typeof error };
      diagnostics?.upstreamException(detail);
      console.error(JSON.stringify({ type: "egress.upstream_exception", ...detail }));
    }
    return auditedError(problem.status, problem.code, request, url, operation.id, started);
  }
}

function sanitizeUpstreamResponse(upstream: Response): Response {
  // An upgraded socket must be returned intact. Its peer is the explicitly
  // trusted provider/relay selected by the fixed rule, never caller input.
  if (upstream.webSocket) return upstream;
  const headers = new Headers(upstream.headers);
  for (const name of [
    "authorization",
    "chatgpt-account-id",
    "proxy-authenticate",
    "proxy-authorization",
    "set-cookie",
    "x-openai-fedramp",
  ]) headers.delete(name);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function handleControl(request: Request, url: URL, env: EgressEnv): Promise<Response> {
  const subjectMatch = url.pathname.match(/^\/subjects\/([A-Za-z0-9_-]{43,128})$/);
  if (subjectMatch) {
    if (request.method !== "PUT" && request.method !== "DELETE") {
      return jsonError(405, "method_not_allowed");
    }
    const body = await readJson(request, MAX_CONTROL_BODY_BYTES);
    const userId = stringField(body, "user_id");
    if (!USER_ID.test(userId ?? "")) return jsonError(400, "invalid_request");
    return directory(env).fetch(`https://subjects.internal/v1/${request.method === "PUT" ? "bind" : "unbind"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: subjectMatch[1], user_id: userId }),
    });
  }

  const userMatch = url.pathname.match(
    /^\/users\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/credentials(?:\/(openai|chatgpt|chatgpt\/login|chatgpt\/login\/status|chatgpt\/local-claim))?$/,
  );
  if (!userMatch) return jsonError(404, "not_found");
  const userId = userMatch[1]!;
  const operation = userMatch[2];

  if (operation === "chatgpt/local-claim") {
    if (request.method !== "POST") return jsonError(405, "method_not_allowed");
    if (!localClaimEnabled(env)) return jsonError(404, "not_found");
    const claim = await directory(env).fetch("https://subjects.internal/v1/claim-local-bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!claim.ok) return claim;
    await claim.body?.cancel();
    const imported = await userBroker(env, userId).fetch("https://credentials.internal/v1/chatgpt/local-claim", {
      method: "POST",
    });
    if (imported.ok) return imported;
    await directory(env).fetch("https://subjects.internal/v1/release-local-bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    return imported;
  }

  if (!operation && request.method === "GET") {
    return userBroker(env, userId).fetch("https://credentials.internal/v1/status");
  }
  if (operation === "openai" && request.method === "PUT") {
    const body = await readJson(request, MAX_CONTROL_BODY_BYTES);
    return userBroker(env, userId).fetch("https://credentials.internal/v1/openai-key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: stringField(body, "api_key") }),
    });
  }
  if (operation === "openai" && request.method === "DELETE") {
    return userBroker(env, userId).fetch("https://credentials.internal/v1/openai-key", {
      method: "DELETE",
    });
  }
  if (operation === "chatgpt/login" && request.method === "POST") {
    return userBroker(env, userId).fetch("https://credentials.internal/v1/chatgpt/login/start", {
      method: "POST",
    });
  }
  if (operation === "chatgpt/login/status" && request.method === "POST") {
    return userBroker(env, userId).fetch("https://credentials.internal/v1/chatgpt/login/status", {
      method: "POST",
    });
  }
  if (operation === "chatgpt" && request.method === "DELETE") {
    return userBroker(env, userId).fetch("https://credentials.internal/v1/chatgpt", {
      method: "DELETE",
    });
  }
  return jsonError(405, "method_not_allowed");
}

async function handleReadiness(request: Request, env: EgressEnv): Promise<Response> {
  if (request.method !== "POST" || request.body !== null) return jsonError(404, "not_found");
  const token = env.NANOCODEX_BROKER_PROBE_TOKEN;
  if (!token || token.length < 32 || token.length > 512
    || request.headers.get("authorization") !== `Bearer ${token}`) {
    return jsonError(404, "not_found");
  }
  try {
    const [subjects, credentials] = await Promise.all([
      directory(env).fetch("https://subjects.internal/v1/health"),
      userBroker(env, "broker-readiness-v1").fetch("https://credentials.internal/v1/health"),
    ]);
    if (!subjects.ok || !credentials.ok) {
      await Promise.all([subjects.body?.cancel(), credentials.body?.cancel()]);
      return jsonError(503, "broker_not_ready");
    }
    await Promise.all([subjects.body?.cancel(), credentials.body?.cancel()]);
    return json({ ready: true }, 200);
  } catch { return jsonError(503, "broker_not_ready"); }
}

async function handleModelStatus(request: Request, env: EgressEnv): Promise<Response> {
  if (request.method !== "GET" || request.body !== null) return jsonError(404, "not_found");
  const subject = request.headers.get(SUBJECT_HEADER);
  if (!subject || !SUBJECT.test(subject)) return jsonError(403, "agent_subject_required");
  try {
    const userId = await resolveSubject(env, subject);
    await resolveCredential(env, userId, false);
    return json({ ready: true }, 200);
  } catch { return jsonError(503, "broker_not_ready"); }
}

function buildUpstreamRequest(
  original: Request,
  env: EgressEnv,
  operation: ModelOperation,
  credential: UserCredentialSnapshot,
  body: Uint8Array | null,
): Request {
  const headers = new Headers();
  const allowed = operation.websocket
    ? ["openai-beta", "session-id", "thread-id", "upgrade", "user-agent",
        "x-client-request-id", "x-codex-turn-state",
        "x-openai-internal-codex-responses-lite", "x-responsesapi-include-timing-metrics"]
    : ["content-type", "user-agent"];
  for (const name of allowed) {
    const value = original.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${credential.secret}`);
  if (credential.kind === "chatgpt") {
    if (!credential.accountId) throw new EgressFailure(503, "credential_field_unavailable");
    headers.set("chatgpt-account-id", credential.accountId);
    if (credential.fedramp) headers.set("x-openai-fedramp", "true");
    if (!operation.websocket) headers.set("originator", "codex_cli_rs");
  }
  return new Request(upstreamUrl(env, operation, credential.kind), {
    method: original.method,
    headers,
    body,
    cache: "no-store",
    redirect: "manual",
  });
}

function upstreamUrl(
  env: EgressEnv,
  operation: ModelOperation,
  kind: UserCredentialSnapshot["kind"],
): URL {
  if (kind === "openai") return new URL(operation.openai);
  const configured = env.CODEX_RELAY_URL?.trim();
  if (!configured) return new URL(operation.chatgpt);
  let relay: URL;
  try { relay = new URL(configured); } catch { throw new EgressFailure(503, "invalid_codex_relay_url"); }
  const publicRelay = relay.protocol === "https:" && !relay.port;
  const localRelay = env.ALLOW_INSECURE_LOOPBACK_RELAY === "true"
    && relay.protocol === "http:" && relay.hostname === "127.0.0.1" && Boolean(relay.port);
  if ((!publicRelay && !localRelay) || relay.username || relay.password || relay.pathname !== "/"
    || relay.search || relay.hash) {
    throw new EgressFailure(503, "invalid_codex_relay_url");
  }
  relay.pathname = new URL(operation.chatgpt).pathname;
  return relay;
}

async function fetchUpstream(
  env: EgressEnv,
  userId: string,
  credential: UserCredentialSnapshot,
  request: Request,
  upstreamFetch: typeof fetch,
): Promise<Response> {
  if (credential.kind !== "chatgpt" || env.CODEX_RELAY_URL) {
    return upstreamFetch(request);
  }
  if (env.CHATGPT_EGRESS) {
    const target = new URL(request.url);
    const internal = new URL(`${target.pathname}${target.search}`, "https://chatgpt-egress.internal");
    const id = env.CHATGPT_EGRESS.idFromName(`user-v1:${userId}`);
    return env.CHATGPT_EGRESS.get(id).fetch(new Request(internal, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    }));
  }
  const environment = env.ENVIRONMENT?.trim().toLowerCase();
  if (environment === "production" || environment === "preview") {
    throw new EgressFailure(503, "chatgpt_relay_unavailable");
  }
  return upstreamFetch(request);
}

async function resolveSubject(env: EgressEnv, subject: string): Promise<string> {
  const response = await directory(env).fetch("https://subjects.internal/v1/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject }),
  });
  if (!response.ok) {
    await readBoundedText(response, MAX_BROKER_RESPONSE_BYTES);
    throw new EgressFailure(response.status === 404 ? 403 : 503, "agent_subject_unavailable");
  }
  const value = await response.json<Record<string, unknown>>();
  const userId = stringField(value, "user_id");
  if (!USER_ID.test(userId ?? "")) throw new EgressFailure(503, "invalid_subject_response");
  return userId!;
}

async function resolveCredential(
  env: EgressEnv,
  userId: string,
  recover: boolean,
  revision?: number,
): Promise<UserCredentialSnapshot> {
  const response = await userBroker(env, userId).fetch("https://credentials.internal/v1/credential", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recover, ...(revision === undefined ? {} : { revision }) }),
  });
  if (!response.ok) {
    await readBoundedText(response, MAX_BROKER_RESPONSE_BYTES);
    throw new EgressFailure(response.status === 404 ? 409 : 503, "user_credential_unavailable");
  }
  const value = await response.json<UserCredentialSnapshot>();
  if ((value.kind !== "openai" && value.kind !== "chatgpt") || !value.secret
    || !Number.isSafeInteger(value.revision)) {
    throw new EgressFailure(503, "invalid_credential_response");
  }
  return value;
}

async function replayableBody(request: Request, operation: ModelOperation): Promise<Uint8Array | null> {
  if (operation.websocket) return null;
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(size)) {
      throw new EgressFailure(400, "invalid_content_length");
    }
    if (size > MAX_MODEL_BODY_BYTES) throw new EgressFailure(413, "request_body_too_large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MODEL_BODY_BYTES) {
        await reader.cancel();
        throw new EgressFailure(413, "request_body_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function directory(env: EgressEnv): DurableObjectStub<AgentSubjectDirectory> {
  return env.AGENT_SUBJECTS.getByName(SUBJECT_DIRECTORY_NAME);
}
function userBroker(env: EgressEnv, userId: string): DurableObjectStub<UserCredentialBroker> {
  return env.USER_CREDENTIALS.getByName(userId);
}
function localClaimEnabled(env: EgressEnv): boolean {
  const environment = env.ENVIRONMENT?.trim().toLowerCase();
  return env.ALLOW_LOCAL_CREDENTIAL_CLAIM === "true"
    && (environment === "development" || environment === "local" || environment === "test");
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
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new EgressFailure(413, "body_too_large"); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" && value[key].trim()
    ? value[key] as string : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });
}
function jsonError(status: number, error: string): Response { return json({ error }, status); }

class EgressFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function egressFailure(error: unknown): EgressFailure {
  return error instanceof EgressFailure ? error : new EgressFailure(502, "upstream_failed");
}
function auditedError(
  status: number,
  code: string,
  request: Request,
  url: URL,
  rule: string | undefined,
  started: number,
): Response {
  audit(status >= 500 ? "error" : "deny", request, url, rule, started, { code, status });
  return jsonError(status, code);
}
function audit(
  action: "allow" | "deny" | "error",
  request: Request,
  url: URL,
  rule: string | undefined,
  started: number,
  detail: Record<string, unknown>,
): void {
  console.log(JSON.stringify({
    type: "egress.request",
    action,
    rule,
    method: request.method,
    host: url.host,
    path: url.pathname,
    duration_ms: Date.now() - started,
    ...detail,
  }));
}
