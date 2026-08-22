import {
  CodexOAuthBroker,
  type CodexCredential,
} from "./broker";

export { CodexOAuthBroker } from "./broker";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BROKER_ERROR_BYTES = 4 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface EgressEnv {
  CODEX_OAUTH: DurableObjectNamespace<CodexOAuthBroker>;
  CODEX_RELAY_URL?: string;
  ALLOW_INSECURE_LOOPBACK_RELAY?: string;
  GITHUB_READ_TOKEN?: string;
  OPENAI_API_KEY?: string;
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
  requiredHeaders: readonly HeaderRequirement[];
  forwardedHeaders: readonly string[];
  replacements: readonly Replacement[];
  credential: CredentialSource;
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
    hostname: "chatgpt.com",
    port: "",
    methods: ["GET"],
    path: { kind: "exact", value: "/backend-api/codex/responses" },
    query: "none",
  },
  requiredHeaders: [
    { name: "upgrade", value: "websocket" },
    { name: "openai-beta", value: "responses_websockets=2026-02-06" },
  ],
  forwardedHeaders: [
    "authorization",
    "chatgpt-account-id",
    "openai-beta",
    "session-id",
    "thread-id",
    "upgrade",
    "user-agent",
    "x-client-request-id",
    "x-codex-turn-state",
    "x-openai-fedramp",
    "x-openai-internal-codex-responses-lite",
    "x-responsesapi-include-timing-metrics",
  ],
  replacements: [
    {
      location: "header",
      name: "authorization",
      placeholder: "Bearer NANOCODEX_CODEX_OAUTH",
      template: "Bearer {{access_token}}",
    },
    {
      location: "header",
      name: "chatgpt-account-id",
      placeholder: "NANOCODEX_CODEX_ACCOUNT",
      template: "{{account_id}}",
    },
  ],
  credential: { kind: "codex_oauth", id: "openai-codex" },
};

const OPENAI_RULE: Rule = {
  id: "openai-responses-websocket",
  policy: "openai",
  route: {
    protocol: "https:",
    hostname: "api.openai.com",
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
      placeholder: "Bearer NANOCODEX_OPENAI_API_KEY",
      template: "Bearer {{secret}}",
    },
  ],
  credential: { kind: "static", binding: "OPENAI_API_KEY" },
};

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

const RULES: readonly Rule[] = [CODEX_RULE, OPENAI_RULE, GITHUB_RULE];

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
  if (!context) return failed("invalid_broker_configuration", undefined, request, started);

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return denied("invalid_url", context, request, started);
  }
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
  if (!placeholdersMatch(rule.replacements, request, url)) {
    return denied("credential_placeholder_mismatch", context, request, started, url, rule.id);
  }

  try {
    const target = upstreamTarget(rule, url, env);
    let credential = await resolveCredential(rule.credential, env, false);
    let upstream = await upstreamFetch(buildRequest(request, target, rule, credential));
    let recovered = false;
    if (upstream.status === 401 && rule.credential.kind === "codex_oauth") {
      const revision = credential.revision;
      if (revision === undefined) throw new EgressFailure(503, "broker_revision_missing");
      await upstream.body?.cancel();
      credential = await resolveCredential(rule.credential, env, true, revision);
      upstream = await upstreamFetch(buildRequest(request, target, rule, credential));
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

function buildRequest(
  request: Request,
  targetUrl: URL,
  rule: Rule,
  credential: CredentialValues,
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
    if (credential.fedramp === "true") headers.set("x-openai-fedramp", "true");
    else headers.delete("x-openai-fedramp");
  }
  return new Request(url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    cache: "no-store",
    redirect: "manual",
  });
}

function upstreamTarget(rule: Rule, original: URL, env: EgressEnv): URL {
  const configured = env.CODEX_RELAY_URL?.trim();
  if (rule.credential.kind !== "codex_oauth" || !configured) return original;

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
  if (configured.length === 0 || configured.some((policy) => !policy)) return undefined;
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
