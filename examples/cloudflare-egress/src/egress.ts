import {
  CodexOAuthBroker,
  type CodexCredential,
} from "./broker";

export { CodexOAuthBroker } from "./broker";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BROKER_READINESS_PATH = "/.well-known/nanocodex/broker-readiness";
const MODEL_STATUS_PATH = "/.well-known/nanocodex/model-status";
const BROKER_READINESS_SESSION_ID = "nanocodex-broker-readiness";
const BROKER_READINESS_CLOSE_TIMEOUT_MS = 2_000;
const MAX_BROKER_ERROR_BYTES = 4 * 1024;
const MAX_MODEL_HTTP_BODY_BYTES = 32 * 1024 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface EgressEnv {
  CODEX_OAUTH: DurableObjectNamespace<CodexOAuthBroker>;
  CODEX_RELAY_URL?: string;
  ALLOW_INSECURE_LOOPBACK_RELAY?: string;
  GITHUB_READ_TOKEN?: string;
  OPENAI_API_KEY?: string;
  NANOCODEX_BROKER_PROBE_TOKEN?: string;
  AGENT_ID: string;
  ALLOWED_POLICIES: string;
}

export type AgentContext = Readonly<{
  agent_id: string;
  policies: ReadonlySet<string>;
}>;

type Route = Readonly<{
  protocol: "https:";
  hostname: string;
  port: "" | `${number}`;
  methods: readonly string[];
  path: Readonly<{ kind: "exact" | "prefix"; value: `/${string}` }>;
  query: "none" | Readonly<{ names: readonly string[] }>;
}>;

type HeaderRequirement = Readonly<{
  name: string;
  value: string;
}>;

type HeaderReplacement = Readonly<{
  location: "header";
  name: string;
  placeholder: string;
  template: string;
}>;

type QueryReplacement = Readonly<{
  location: "query";
  name: string;
  placeholder: string;
  template: string;
}>;

type Replacement = HeaderReplacement | QueryReplacement;

type CredentialSource =
  | Readonly<{ kind: "codex_oauth"; id: string }>
  | Readonly<{ kind: "static"; binding: "GITHUB_READ_TOKEN" | "OPENAI_API_KEY" }>;

type Rule = Readonly<{
  id: string;
  policy: string;
  route: Route;
  upstream?: `https://${string}`;
  requiredHeaders: readonly HeaderRequirement[];
  forwardedHeaders: readonly string[];
  replacements: readonly Replacement[];
  credential: CredentialSource;
  maxBodyBytes?: number;
}>;

type CredentialValues = Readonly<{
  [key: string]: string | number | undefined;
  revision?: number;
}>;

const CODEX_RULE: Rule = {
  id: "codex-responses-websocket",
  policy: "codex",
  route: {
    protocol: "https:",
    hostname: "nanocodex.internal",
    port: "",
    methods: ["GET"],
    path: { kind: "exact", value: "/v1/responses" },
    query: "none",
  },
  requiredHeaders: [
    { name: "upgrade", value: "websocket" },
    { name: "openai-beta", value: "responses_websockets=2026-02-06" },
  ],
  forwardedHeaders: [
    "authorization",
    "openai-beta",
    "session-id",
    "thread-id",
    "upgrade",
    "user-agent",
    "x-client-request-id",
    "x-codex-turn-state",
    "x-openai-internal-codex-responses-lite",
    "x-responsesapi-include-timing-metrics",
  ],
  replacements: [
    {
      location: "header",
      name: "authorization",
      placeholder: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
      template: "Bearer {{access_token}}",
    },
  ],
  upstream: "https://chatgpt.com/backend-api/codex/responses",
  credential: { kind: "codex_oauth", id: "openai-codex" },
};

const OPENAI_RULE: Rule = {
  id: "openai-responses-websocket",
  policy: "openai",
  route: {
    protocol: "https:",
    hostname: "nanocodex.internal",
    port: "",
    methods: ["GET"],
    path: { kind: "exact", value: "/v1/responses" },
    query: "none",
  },
  requiredHeaders: [
    { name: "upgrade", value: "websocket" },
    { name: "openai-beta", value: "responses_websockets=2026-02-06" },
  ],
  forwardedHeaders: [
    "authorization",
    "openai-beta",
    "session-id",
    "thread-id",
    "upgrade",
    "user-agent",
    "x-client-request-id",
    "x-codex-turn-state",
    "x-openai-internal-codex-responses-lite",
    "x-responsesapi-include-timing-metrics",
  ],
  replacements: [
    {
      location: "header",
      name: "authorization",
      placeholder: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
      template: "Bearer {{secret}}",
    },
  ],
  upstream: "https://api.openai.com/v1/responses",
  credential: { kind: "static", binding: "OPENAI_API_KEY" },
};

function modelHttpRule(
  id: string,
  policy: "codex" | "openai",
  path: `/v1/${string}`,
  upstream: `https://${string}`,
  credential: CredentialSource,
): Rule {
  return {
    id,
    policy,
    route: {
      protocol: "https:",
      hostname: "nanocodex.internal",
      port: "",
      methods: ["POST"],
      path: { kind: "exact", value: path },
      query: "none",
    },
    requiredHeaders: [{ name: "content-type", value: "application/json" }],
    forwardedHeaders: ["authorization", "content-type", "user-agent"],
    replacements: [{
      location: "header",
      name: "authorization",
      placeholder: "Bearer NANOCODEX_PROVIDER_CREDENTIAL",
      template: policy === "codex" ? "Bearer {{access_token}}" : "Bearer {{secret}}",
    }],
    upstream,
    credential,
    maxBodyBytes: MAX_MODEL_HTTP_BODY_BYTES,
  };
}

const CODEX_HTTP_RULES: readonly Rule[] = [
  modelHttpRule(
    "codex-web-search",
    "codex",
    "/v1/search",
    "https://chatgpt.com/backend-api/codex/alpha/search",
    CODEX_RULE.credential,
  ),
  modelHttpRule(
    "codex-image-generation",
    "codex",
    "/v1/images/generations",
    "https://chatgpt.com/backend-api/codex/images/generations",
    CODEX_RULE.credential,
  ),
  modelHttpRule(
    "codex-image-edit",
    "codex",
    "/v1/images/edits",
    "https://chatgpt.com/backend-api/codex/images/edits",
    CODEX_RULE.credential,
  ),
];

const OPENAI_HTTP_RULES: readonly Rule[] = [
  modelHttpRule(
    "openai-web-search",
    "openai",
    "/v1/search",
    "https://api.openai.com/v1/alpha/search",
    OPENAI_RULE.credential,
  ),
  modelHttpRule(
    "openai-image-generation",
    "openai",
    "/v1/images/generations",
    "https://api.openai.com/v1/images/generations",
    OPENAI_RULE.credential,
  ),
  modelHttpRule(
    "openai-image-edit",
    "openai",
    "/v1/images/edits",
    "https://api.openai.com/v1/images/edits",
    OPENAI_RULE.credential,
  ),
];

const GITHUB_RULE: Rule = {
  id: "github-read-user",
  policy: "github-readonly",
  route: {
    protocol: "https:",
    hostname: "api.github.com",
    port: "",
    methods: ["GET"],
    path: { kind: "exact", value: "/user" },
    query: "none",
  },
  requiredHeaders: [],
  forwardedHeaders: [
    "accept",
    "authorization",
    "user-agent",
    "x-github-api-version",
  ],
  replacements: [
    {
      location: "header",
      name: "authorization",
      placeholder: "Bearer NANOCODEX_GITHUB_TOKEN",
      template: "Bearer {{secret}}",
    },
  ],
  credential: { kind: "static", binding: "GITHUB_READ_TOKEN" },
};

const RULES: readonly Rule[] = [
  CODEX_RULE,
  OPENAI_RULE,
  ...CODEX_HTTP_RULES,
  ...OPENAI_HTTP_RULES,
  GITHUB_RULE,
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
  diagnostics?: Readonly<{
    upstreamException(error: Readonly<{ name: string }>): void;
  }>,
): Promise<Response> {
  const started = Date.now();
  const context = agentContext(env);

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return context
      ? denied("invalid_url", context, request, started)
      : failed("invalid_broker_configuration", undefined, request, started);
  }
  if (url.pathname === BROKER_READINESS_PATH) {
    return handleBrokerReadiness(request, url, env, context, upstreamFetch, diagnostics);
  }
  if (url.pathname === MODEL_STATUS_PATH) {
    return handleModelStatus(request, url, env, context);
  }
  if (!context) return failed("invalid_broker_configuration", undefined, request, started);
  if (url.username || url.password || url.hash) {
    return denied("url_credentials_forbidden", context, request, started);
  }

  const rule = RULES.find((candidate) => (
    context.policies.has(candidate.policy) && routeMatches(candidate.route, request, url)
  ));
  if (!rule) return denied("destination_denied", context, request, started, url);
  if (!headersMatch(rule.requiredHeaders, request.headers)) {
    return denied("required_header_mismatch", context, request, started, url, rule.id);
  }
  if (rule.upstream
    && (request.headers.has("chatgpt-account-id") || request.headers.has("x-openai-fedramp"))) {
    return denied("provider_header_forbidden", context, request, started, url, rule.id);
  }
  if (!placeholdersMatch(rule.replacements, request, url)) {
    return denied("credential_placeholder_mismatch", context, request, started, url, rule.id);
  }

  try {
    const body = await replayableRequestBody(request, rule);
    const target = upstreamTarget(rule, url, env);
    let credential = await resolveCredential(rule.credential, env, false);
    let upstream = await upstreamFetch(buildRequest(request, target, rule, credential, body));
    let recovered = false;
    if (upstream.status === 401 && rule.credential.kind === "codex_oauth") {
      const revision = credential.revision;
      if (revision === undefined) throw new EgressFailure(503, "broker_revision_missing");
      await upstream.body?.cancel();
      credential = await resolveCredential(rule.credential, env, true, revision);
      upstream = await upstreamFetch(buildRequest(request, target, rule, credential, body));
      recovered = true;
    }
    if (REDIRECT_STATUS.has(upstream.status)) {
      await upstream.body?.cancel();
      audit("deny", context, request, url, rule.id, started, {
        code: "upstream_redirect_blocked",
        status: upstream.status,
      });
      return response(502, "upstream_redirect_blocked");
    }
    if (upstream.status >= 400) {
      const upstreamStatus = upstream.status;
      await upstream.body?.cancel();
      audit("deny", context, request, url, rule.id, started, {
        code: "upstream_rejected",
        status: upstreamStatus,
      });
      return response(upstreamStatus === 429 ? 503 : 502, "upstream_rejected");
    }
    audit("allow", context, request, url, rule.id, started, {
      status: upstream.status,
      recovered,
    });
    return upstream;
  } catch (error) {
    const failure = egressFailure(error);
    if (!(error instanceof EgressFailure)) {
      const detail = {
        name: error instanceof Error ? error.name : typeof error,
      };
      diagnostics?.upstreamException(detail);
      console.error(JSON.stringify({
        type: "egress.upstream_exception",
        ...detail,
      }));
    }
    audit("error", context, request, url, rule.id, started, {
      code: failure.code,
      status: failure.status,
    });
    return response(failure.status, failure.code);
  }
}

async function handleBrokerReadiness(
  request: Request,
  url: URL,
  env: EgressEnv,
  context: AgentContext | undefined,
  upstreamFetch: typeof fetch,
  diagnostics?: Readonly<{
    upstreamException(error: Readonly<{ name: string }>): void;
  }>,
): Promise<Response> {
  if (!await exactReadinessRequest(request, url, env.NANOCODEX_BROKER_PROBE_TOKEN)) {
    return response(404, "not_found");
  }
  if (!context) return readinessUnavailable();

  const rule = readinessRule(context);
  if (!rule) return readinessUnavailable();

  const upgraded = await handleEgress(
    readinessUpgradeRequest(rule),
    env,
    undefined,
    upstreamFetch,
    diagnostics,
  );
  if (upgraded.status !== 101 || !upgraded.webSocket) {
    await cancelBody(upgraded);
    return readinessUnavailable();
  }

  if (!await closeReadinessSocket(upgraded.webSocket)) return readinessUnavailable();

  return Response.json({ ready: true }, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

async function handleModelStatus(
  request: Request,
  url: URL,
  env: EgressEnv,
  context: AgentContext | undefined,
): Promise<Response> {
  if (request.method !== "GET"
    || request.body !== null
    || url.username
    || url.password
    || url.search
    || url.hash) {
    return response(404, "not_found");
  }
  if (!context) return readinessUnavailable();
  const rule = readinessRule(context);
  if (!rule) return readinessUnavailable();
  try {
    await resolveCredential(rule.credential, env, false);
  } catch {
    return readinessUnavailable();
  }
  return Response.json({
    ready: true,
  }, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

async function closeReadinessSocket(socket: WebSocket): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let closeListener: (() => void) | undefined;
  const closed = new Promise<boolean>((resolveClosed) => {
    closeListener = () => resolveClosed(true);
    socket.addEventListener("close", closeListener, { once: true });
    timeout = setTimeout(() => resolveClosed(false), BROKER_READINESS_CLOSE_TIMEOUT_MS);
  });
  try {
    socket.accept();
    socket.close(1000, "readiness_complete");
    return await closed;
  } catch {
    try {
      socket.close(1011, "readiness_failed");
    } catch {
      // The proof still fails closed if an upgraded socket cannot be closed.
    }
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (closeListener) socket.removeEventListener("close", closeListener);
  }
}

async function exactReadinessRequest(
  request: Request,
  url: URL,
  token: string | undefined,
): Promise<boolean> {
  if (request.method !== "POST"
    || url.username
    || url.password
    || url.search
    || url.hash) {
    return false;
  }
  if (!token
    || token.length < 32
    || token.length > 512
    || token.trim() !== token
    || /[\u0000-\u0020\u007f]/.test(token)) {
    return false;
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) return false;
  return requestBodyIsEmpty(request);
}

async function requestBodyIsEmpty(request: Request): Promise<boolean> {
  if (!request.body) return true;
  const reader = request.body.getReader();
  try {
    for (let readCount = 0; readCount < 4; readCount += 1) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (value.byteLength > 0) {
        await reader.cancel();
        return false;
      }
    }
    await reader.cancel();
    return false;
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

function readinessRule(context: AgentContext): Rule | undefined {
  if (context.policies.has(CODEX_RULE.policy)) return CODEX_RULE;
  if (context.policies.has(OPENAI_RULE.policy)) return OPENAI_RULE;
  return undefined;
}

function readinessUpgradeRequest(rule: Rule): Request {
  const route = rule.route;
  if (route.path.kind !== "exact" || route.query !== "none") {
    throw new EgressFailure(503, "invalid_readiness_rule");
  }
  const url = new URL(
    `${route.protocol}//${route.hostname}${route.port ? `:${route.port}` : ""}${route.path.value}`,
  );
  const headers = new Headers({
    "session-id": BROKER_READINESS_SESSION_ID,
    "thread-id": BROKER_READINESS_SESSION_ID,
    "user-agent": BROKER_READINESS_SESSION_ID,
    "x-client-request-id": BROKER_READINESS_SESSION_ID,
  });
  for (const requirement of rule.requiredHeaders) {
    headers.set(requirement.name, requirement.value);
  }
  for (const replacement of rule.replacements) {
    if (replacement.location === "header") {
      headers.set(replacement.name, replacement.placeholder);
    } else {
      url.searchParams.set(replacement.name, replacement.placeholder);
    }
  }
  return new Request(url, { method: "GET", headers });
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Readiness responses never expose an upstream body or cancellation failure.
  }
}

function readinessUnavailable(): Response {
  return response(503, "broker_not_ready");
}

function buildRequest(
  request: Request,
  targetUrl: URL,
  rule: Rule,
  credential: CredentialValues,
  body: Uint8Array | null,
): Request {
  const url = new URL(targetUrl);
  const headers = new Headers();
  for (const name of rule.forwardedHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const replacement of rule.replacements) {
    const value = render(replacement.template, credential);
    if (replacement.location === "header") headers.set(replacement.name, value);
    else url.searchParams.set(replacement.name, value);
  }
  if (rule.credential.kind === "codex_oauth") {
    const accountId = credential.account_id;
    if (typeof accountId !== "string" || !accountId) {
      throw new EgressFailure(503, "credential_field_unavailable");
    }
    headers.set("chatgpt-account-id", accountId);
    if (rule.id !== CODEX_RULE.id) headers.set("originator", "codex_cli_rs");
    if (credential.fedramp === "true") headers.set("x-openai-fedramp", "true");
    else headers.delete("x-openai-fedramp");
  }
  return new Request(url, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
    redirect: "manual",
  });
}

async function replayableRequestBody(request: Request, rule: Rule): Promise<Uint8Array | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const limit = rule.maxBodyBytes;
  if (limit === undefined) {
    throw new EgressFailure(403, "request_body_forbidden");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(bytes)) {
      throw new EgressFailure(400, "invalid_content_length");
    }
    if (bytes > limit) throw new EgressFailure(413, "request_body_too_large");
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
      if (total > limit) {
        await reader.cancel();
        throw new EgressFailure(413, "request_body_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof EgressFailure) throw error;
    throw new EgressFailure(400, "request_body_unavailable");
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function upstreamTarget(rule: Rule, original: URL, env: EgressEnv): URL {
  const providerTarget = rule.upstream ? new URL(rule.upstream) : original;
  const configured = env.CODEX_RELAY_URL?.trim();
  if (rule.credential.kind !== "codex_oauth" || !configured) return providerTarget;

  let relay: URL;
  try {
    relay = new URL(configured);
  } catch {
    throw new EgressFailure(503, "invalid_codex_relay_url");
  }
  const publicRelay = relay.protocol === "https:" && !relay.port;
  const localDevelopmentRelay = env.ALLOW_INSECURE_LOOPBACK_RELAY === "true"
    && relay.protocol === "http:"
    && relay.hostname === "127.0.0.1"
    && relay.port !== "";
  if ((!publicRelay && !localDevelopmentRelay)
    || relay.username
    || relay.password
    || relay.pathname === "/"
    || relay.search
    || relay.hash) {
    throw new EgressFailure(503, "invalid_codex_relay_url");
  }
  if (rule.id !== CODEX_RULE.id) {
    relay.pathname = `${relay.pathname.replace(/\/$/, "")}/http/${rule.id}`;
  }
  return relay;
}

async function resolveCredential(
  source: CredentialSource,
  env: EgressEnv,
  recover: boolean,
  revision?: number,
): Promise<CredentialValues> {
  if (source.kind === "static") {
    const secret = env[source.binding]?.trim();
    if (!secret) throw new EgressFailure(503, "static_credential_unavailable");
    return { secret };
  }
  const stub = env.CODEX_OAUTH.getByName(source.id);
  const broker = await stub.fetch(
    `https://codex-oauth.internal/v1/${recover ? "recover" : "token"}`,
    {
      method: "POST",
      ...(recover ? { body: JSON.stringify({ revision }) } : {}),
    },
  );
  if (!broker.ok) {
    await readBoundedText(broker, MAX_BROKER_ERROR_BYTES);
    throw new EgressFailure(broker.status === 422 ? 502 : 503, "codex_credential_unavailable");
  }
  const credential = await broker.json<CodexCredential>();
  if (!credential.accessToken || !credential.accountId || !Number.isSafeInteger(credential.revision)) {
    throw new EgressFailure(503, "invalid_broker_response");
  }
  return {
    access_token: credential.accessToken,
    account_id: credential.accountId,
    fedramp: String(credential.fedramp),
    revision: credential.revision,
  };
}

function routeMatches(route: Route, request: Request, url: URL): boolean {
  if (url.protocol !== route.protocol
    || url.hostname !== route.hostname
    || url.port !== route.port
    || !route.methods.includes(request.method.toUpperCase())) {
    return false;
  }
  if (route.path.kind === "exact" && url.pathname !== route.path.value) return false;
  if (route.path.kind === "prefix"
    && url.pathname !== route.path.value
    && !url.pathname.startsWith(`${route.path.value.replace(/\/$/, "")}/`)) {
    return false;
  }
  const query = route.query;
  if (query === "none") return url.search === "";
  return [...url.searchParams.keys()].every((name) => query.names.includes(name));
}

function headersMatch(requirements: readonly HeaderRequirement[], headers: Headers): boolean {
  return requirements.every((requirement) => (
    headers.get(requirement.name)?.toLowerCase() === requirement.value.toLowerCase()
  ));
}

function placeholdersMatch(
  replacements: readonly Replacement[],
  request: Request,
  url: URL,
): boolean {
  return replacements.every((replacement) => {
    if (replacement.location === "header") {
      return request.headers.get(replacement.name) === replacement.placeholder;
    }
    const values = url.searchParams.getAll(replacement.name);
    return values.length === 1 && values[0] === replacement.placeholder;
  });
}

function render(template: string, values: CredentialValues): string {
  const rendered = template.replace(/\{\{([a-z_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (typeof value !== "string" || !value) {
      throw new EgressFailure(503, "credential_field_unavailable");
    }
    return value;
  });
  if (/\{\{.*\}\}/.test(rendered)) {
    throw new EgressFailure(503, "invalid_credential_template");
  }
  return rendered;
}

function agentContext(env: Pick<EgressEnv, "AGENT_ID" | "ALLOWED_POLICIES">): AgentContext | undefined {
  if (!AGENT_ID.test(env.AGENT_ID)) return undefined;
  const configured = env.ALLOWED_POLICIES.split(",").map((policy) => policy.trim());
  if (configured.length !== 1 || !configured[0]) return undefined;
  const known = new Set(RULES.map((rule) => rule.policy));
  if (configured.some((policy) => !known.has(policy))) return undefined;
  return { agent_id: env.AGENT_ID, policies: new Set(configured) };
}

function denied(
  code: string,
  context: AgentContext | undefined,
  request: Request,
  started: number,
  url?: URL,
  rule?: string,
): Response {
  audit("deny", context, request, url, rule, started, { code, status: 403 });
  return response(403, code);
}

function failed(
  code: string,
  context: AgentContext | undefined,
  request: Request,
  started: number,
): Response {
  audit("error", context, request, undefined, undefined, started, { code, status: 503 });
  return response(503, code);
}

function response(status: number, code: string): Response {
  return Response.json({ error: code }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function audit(
  action: "allow" | "deny" | "error",
  context: AgentContext | undefined,
  request: Request,
  url: URL | undefined,
  rule: string | undefined,
  started: number,
  detail: Record<string, unknown>,
): void {
  console.log(JSON.stringify({
    type: "egress.request",
    action,
    agent_id: context?.agent_id,
    policies: context ? [...context.policies] : undefined,
    rule,
    method: request.method,
    host: url?.host,
    path: url?.pathname,
    duration_ms: Date.now() - started,
    ...detail,
  }));
}

class EgressFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function egressFailure(error: unknown): EgressFailure {
  return error instanceof EgressFailure
    ? error
    : new EgressFailure(502, "upstream_failed");
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return text;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
