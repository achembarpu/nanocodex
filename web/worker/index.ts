import {
  CHATGPT_LOGIN_TTL_MS,
  CHATGPT_SESSION_TTL_MS,
  ChatGptSession,
  type ChatGptCredential,
  type ChatGptOperation,
} from "./subscriptionAuth.ts";
import {
  fetchChatGpt,
  type ChatGptEgressEnv,
  warmChatGptEgress,
} from "./chatGptEgressClient.ts";
import { CredentialVault, type CredentialVaultEnv, type EncryptedEnvelope } from "./credentialVault.ts";
import { EvalCoordinator, routeEvalMutation, type EvalStorageEnv } from "./evalCoordinator.ts";
import { routeEvalRead } from "./evalReadApi.ts";
import { handleGitRequest, type GitStorageEnv } from "./gitRoutes.ts";
import { GitRepository } from "./gitRepository.ts";
import {
  handleThreadGitRequest,
  type ThreadGitStorageEnv,
} from "./threadRoutes.ts";
import { ThreadGitRepository } from "./threadRepository.ts";
import {
  apiKeyActorId,
  limitAgentOperation,
  limitLoginStart,
  limitSessionPoll,
  type PublicSecurityEnv,
} from "./publicSecurity.ts";

export { ChatGptSession, EvalCoordinator, GitRepository, ThreadGitRepository };

const json = (body: unknown, init?: ResponseInit) =>
  Response.json(body, {
    ...init,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...init?.headers,
    },
  });

const RESPONSES_UPGRADE_URL = "https://api.openai.com/v1/responses";
const CHATGPT_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
const LOCAL_CHATGPT_API_BASE_URL = "http://127.0.0.1:8791/backend-api/codex";
const RESPONSES_WEBSOCKETS_BETA = "responses_websockets=2026-02-06";
const WEB_SEARCH_URL = "https://api.openai.com/v1/alpha/search";
const IMAGE_GENERATION_URL = "https://api.openai.com/v1/images/generations";
const IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";
const MODEL = "gpt-5.6-sol";
const IMAGE_MODEL = "gpt-image-2";
const CHATGPT_REALTIME_MODEL = "gpt-live-1-boulder-alpha";
const CHATGPT_REALTIME_VOICES = new Set([
  "juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove",
]);
const CHATGPT_REALTIME_INSTRUCTIONS = `You are Codex, a concise and warm conversational surface for the coding agent visible on the page.
Treat the coding agent and yourself as one assistant. Never mention a backend or separate system.
For every action or task, create a client delegation. Use direct speech only for brief conversation that needs no tools or execution.
The coding agent's visible output is authoritative. Summarize it naturally without repeating long code, tables, or structured data.
Running work remains steerable: delegate corrections and new instructions immediately.`;
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_USER_AGENT = "codex_cli_rs/0.0.0";
const MAX_JSON_BODY_CHARS = 32 * 1024 * 1024;
const MAX_SEARCH_OUTPUT_CHARS = 1024 * 1024;
const MAX_API_KEY_CHARS = 1_024;
const MAX_REALTIME_SDP_CHARS = 1024 * 1024;
const REALTIME_SIDEBAND_URL = "https://api.openai.com/v1/live";
const MAX_WEBSOCKET_MESSAGE_CHARS = 8 * 1024 * 1024;
const BYOK_SESSION_TTL_MS = 60 * 60 * 1_000;
const BYOK_COOKIE = "nanocodex_byok_v2";
const SECURE_BYOK_COOKIE = "__Secure-nanocodex_byok_v2";
const CHATGPT_COOKIE = "nanocodex_chatgpt_v2";
const SECURE_CHATGPT_COOKIE = "__Secure-nanocodex_chatgpt_v2";

type WorkerEnv = GitStorageEnv & ThreadGitStorageEnv & EvalStorageEnv & ChatGptEgressEnv
  & PublicSecurityEnv & CredentialVaultEnv & {
  ENVIRONMENT: string;
  OPENAI_API_KEY?: string;
  CHATGPT_ISSUER?: string;
  BYOK_SESSIONS?: DurableObjectNamespace;
  CHATGPT_SESSIONS?: DurableObjectNamespace;
};

type ApiKeyCredential = {
  kind: "api_key";
  apiKey: string;
  actorId: string;
  source: "user" | "deployment";
};
type SubscriptionCredential = ChatGptCredential & {
  actorId: string;
  sessionId: string;
  leaseId?: string;
  source: "subscription";
};
type Credential = ApiKeyCredential | SubscriptionCredential;
type StoredCredential = { apiKey: string; expiresAt: number };

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    context?: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/urpc/consumer.json"
    ) {
      return consumerDiscovery(url);
    }
    const evalMutation = await routeEvalMutation(request, env, url);
    if (evalMutation != null) return evalMutation;
    const evalRead = await routeEvalRead(request, env, url, context);
    if (evalRead != null) return evalRead;
    const gitResponse = await handleGitRequest(request, env, url, context);
    if (gitResponse != null) return gitResponse;
    const threadGitResponse = await handleThreadGitRequest(request, env, url, context);
    if (threadGitResponse != null) return threadGitResponse;

    if (url.pathname === "/api/health" && request.method === "GET") {
      const resolved = await resolveCredential(request, env, "health");
      const credential = resolved instanceof Response ? undefined : resolved;
      if (credential?.kind === "chatgpt" && context) {
        context.waitUntil(warmChatGptEgress(env, credential.sessionId));
      }
      return json({
        agent_configured: Boolean(credential),
        credential_source: credential?.source ?? null,
        service: "nanocodex",
        runtime: "cloudflare-workers",
        status: "ok",
      });
    }

    if (url.pathname === "/api/auth/chatgpt" && request.method === "POST") {
      return startChatGptSession(request, env, url);
    }

    if (url.pathname === "/api/auth/chatgpt" && request.method === "GET") {
      return chatGptSessionStatus(request, env, context);
    }

    if (url.pathname === "/api/auth/chatgpt" && request.method === "DELETE") {
      return clearChatGptSession(request, env, url);
    }

    if (url.pathname === "/api/auth/openai" && request.method === "PUT") {
      return createByokSession(request, env, url);
    }

    if (url.pathname === "/api/auth/openai" && request.method === "DELETE") {
      return clearByokSession(request, env, url);
    }

    if (url.pathname === "/api/responses") {
      return upgradeResponsesWebSocket(request, env, url, context);
    }

    if (url.pathname === "/api/realtime/sideband") {
      return upgradeRealtimeSideband(request, env, url);
    }

    if (url.pathname === "/api/realtime/calls" && request.method === "POST") {
      return createRealtimeCall(request, env, url);
    }

    if (url.pathname === "/api/tools/web-search" && request.method === "POST") {
      return proxyWebSearch(request, env, url);
    }

    if (url.pathname === "/api/tools/image-generation" && request.method === "POST") {
      return proxyImageGeneration(request, env, url);
    }

    if (url.pathname === "/api/proposals" && request.method === "POST") {
      return json(
        {
          status: "payment_required",
          mode: "testnet_preview",
          amount: "0.20",
          currency: "USD",
          message: "A live MPP challenge will replace this preview response.",
        },
        { status: 402 },
      );
    }

    return json({ error: "not_found" }, { status: 404 });
  },
};

function consumerDiscovery(url: URL): Response {
  return Response.json(
    {
      version: "1.0",
      id: url.hostname,
      origin: url.origin,
      name: "Nanocodex",
      description: "A compact, browser-native Codex agent powered through Tempo MPP.",
      website_url: url.origin,
    },
    {
      headers: {
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

async function proxyWebSearch(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const credential = await validateToolRequest(request, env, url, "search");
  if (credential instanceof Response) return credential;
  const decoded = await readJsonBody(request);
  if (decoded instanceof Response) return decoded;
  const sessionId = typeof decoded.session_id === "string" ? decoded.session_id : "";
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) return json({ error: "invalid session" }, { status: 400 });
  const commands = asObject(decoded.commands);
  if (!commands || !hasWebOperation(commands)) {
    return json({ error: "web__run requires at least one operation" }, { status: 400 });
  }
  const queries = Array.isArray(commands.search_query) ? commands.search_query.length : 0;
  if (queries > 4) return json({ error: "web__run accepts at most 4 search queries" }, { status: 400 });
  if (queries === 4 && !["medium", "long"].includes(String(commands.response_length))) {
    return json({ error: "four search queries require medium or long response_length" }, { status: 400 });
  }
  const upstreamUrl = credential.kind === "chatgpt"
    ? `${chatGptApiBaseUrl(env)}/alpha/search`
    : WEB_SEARCH_URL;
  const upstream = await fetchOpenAi(credential, env, upstreamUrl, {
      method: "POST",
      headers: openAiHeaders(credential),
      body: JSON.stringify({
        id: sessionId,
        model: MODEL,
        commands,
        settings: { allowed_callers: ["direct"], external_web_access: true },
        max_output_tokens: 10_000,
      }),
    });
  const body = await upstream.text();
  if (body.length > MAX_SEARCH_OUTPUT_CHARS) {
    return json({ error: "web search response exceeded 1 MiB" }, { status: 502 });
  }
  if (!upstream.ok) return upstreamError("web search", upstream.status, body);
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return json({ error: "web search returned invalid JSON" }, { status: 502 }); }
  const output = asObject(payload)?.output;
  if (typeof output !== "string") return json({ error: "web search response omitted output" }, { status: 502 });
  return json({ output });
}

async function proxyImageGeneration(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const credential = await validateToolRequest(request, env, url, "image");
  if (credential instanceof Response) return credential;
  const decoded = await readJsonBody(request);
  if (decoded instanceof Response) return decoded;
  const prompt = typeof decoded.prompt === "string" ? decoded.prompt.trim() : "";
  if (!prompt) return json({ error: "image prompt must not be empty" }, { status: 400 });
  const images = Array.isArray(decoded.images)
    ? decoded.images.filter((image): image is string => typeof image === "string")
    : [];
  if (images.length > 5 || images.some((image) => !image.startsWith("data:image/"))) {
    return json({ error: "image edits require at most five data-image inputs" }, { status: 400 });
  }
  const imageUrl = credential.kind === "chatgpt"
    ? `${chatGptApiBaseUrl(env)}/images/${images.length ? "edits" : "generations"}`
    : images.length ? IMAGE_EDIT_URL : IMAGE_GENERATION_URL;
  const body = JSON.stringify({
    ...(images.length ? { images: images.map((image_url) => ({ image_url })) } : {}),
    prompt,
    background: "auto",
    model: IMAGE_MODEL,
    quality: "auto",
    size: "auto",
  });
  const upstream = await fetchOpenAi(credential, env, imageUrl, {
    method: "POST",
    headers: openAiHeaders(credential),
    body,
  });
  const payload = await upstream.json().catch(() => undefined) as {
    data?: Array<{ b64_json?: unknown }>;
    error?: { message?: unknown };
  } | undefined;
  if (!upstream.ok) {
    const message = typeof payload?.error?.message === "string" ? payload.error.message : `HTTP ${upstream.status}`;
    return json({ error: `image generation failed: ${message}` }, { status: 502 });
  }
  const encoded = payload?.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || !encoded) {
    return json({ error: "image generation returned no image" }, { status: 502 });
  }
  return json({ image_url: `data:image/png;base64,${encoded}` });
}

async function createRealtimeCall(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (!sameOrigin(request, url, env)) return json({ error: "forbidden" }, { status: 403 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "expected JSON" }, { status: 415 });
  }
  const decoded = await readJsonBody(request);
  if (decoded instanceof Response) return decoded;
  const sdp = typeof decoded.sdp === "string" ? decoded.sdp : "";
  const sessionId = typeof decoded.session_id === "string" ? decoded.session_id : "";
  const voice = typeof decoded.voice === "string" ? decoded.voice : "";
  if (!sdp || sdp.length > MAX_REALTIME_SDP_CHARS) {
    return json({ error: "invalid WebRTC offer" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) {
    return json({ error: "invalid session" }, { status: 400 });
  }
  if (!CHATGPT_REALTIME_VOICES.has(voice)) {
    return json({ error: "unsupported ChatGPT voice" }, { status: 400 });
  }
  const resolved = await resolveSubscriptionCredential(request, env, "health");
  if (resolved instanceof Response) return resolved;
  let credential = resolved;
  if (!credential) {
    return json({ error: "voice requires an authenticated ChatGPT subscription" }, { status: 503 });
  }
  const limited = await limitAgentOperation(env, credential.actorId, "socket");
  if (limited) return limited;
  let upstream = await openRealtimeCall(credential, env, sdp, sessionId, voice);
  if (upstream.status === 401) {
    await upstream.body?.cancel();
    const recovered = await recoverSubscriptionCredential(request, env, credential);
    if (recovered) {
      credential = recovered;
      upstream = await openRealtimeCall(credential, env, sdp, sessionId, voice);
    }
  }
  const callId = realtimeCallId(upstream.headers.get("location"));
  const answer = await upstream.text();
  if (answer.length > MAX_REALTIME_SDP_CHARS) {
    return json({ error: "Realtime answer exceeded 1 MiB" }, { status: 502 });
  }
  if (!upstream.ok) return upstreamError("Realtime call", upstream.status, answer);
  if (!callId) {
    return json({ error: "Realtime call response omitted a call ID" }, { status: 502 });
  }
  return new Response(answer, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/sdp",
      "x-nanocodex-realtime-call-id": callId,
    },
  });
}

function realtimeCallId(location: string | null): string | undefined {
  if (!location) return undefined;
  return location
    .split("?", 1)[0]
    .split("/")
    .reverse()
    .find((segment) => (segment.startsWith("rtc_") && segment.length > 4) || isUuid(segment));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function openRealtimeCall(
  credential: SubscriptionCredential,
  env: WorkerEnv,
  sdp: string,
  sessionId: string,
  voice: string,
): Promise<Response> {
  const endpoint = `${chatGptApiBaseUrl(env)}/realtime/calls?intent=quicksilver&architecture=avas`;
  return fetch(endpoint, {
    method: "POST",
    headers: {
      ...openAiHeaders(credential),
      "openai-alpha": "quicksilver=v2",
      "x-oai-attestation": '{"v":1,"s":1}',
      "x-session-id": sessionId,
      "session-id": sessionId,
      "thread-id": sessionId,
    },
    body: JSON.stringify({
      sdp,
      session: {
        model: CHATGPT_REALTIME_MODEL,
        instructions: CHATGPT_REALTIME_INSTRUCTIONS,
        audio: { output: { voice } },
        delegation: { type: "client" },
      },
    }),
  });
}

async function upgradeRealtimeSideband(
  request: Request,
  env: WorkerEnv,
  url: URL,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  if (!sameOrigin(request, url, env)) return new Response("Forbidden", { status: 403 });
  const callId = url.searchParams.get("call_id") ?? "";
  const sessionId = url.searchParams.get("session_id") ?? "";
  if (!realtimeCallId(callId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) {
    return new Response("Invalid Realtime session", { status: 400 });
  }
  const leaseId = randomSessionId();
  const resolved = await resolveSubscriptionCredential(request, env, "socket", leaseId);
  if (resolved instanceof Response) return webSocketError(resolved);
  let credential = resolved;
  if (!credential) {
    return new Response("Voice requires an authenticated ChatGPT subscription", { status: 503 });
  }
  const limited = await limitAgentOperation(env, credential.actorId, "socket");
  if (limited) {
    await releaseSubscriptionLease(env, credential);
    return webSocketError(limited);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await openRealtimeSidebandWithRetry(credential, callId, sessionId);
  } catch (error) {
    await releaseSubscriptionLease(env, credential);
    const detail = error instanceof Error ? error.message : String(error);
    return new Response(`Realtime sideband upgrade request failed: ${detail}`, { status: 502 });
  }
  if (upstreamResponse.status === 401) {
    await upstreamResponse.body?.cancel();
    const recovered = await recoverSubscriptionCredential(request, env, credential);
    if (recovered) {
      credential = recovered;
      upstreamResponse = await openRealtimeSidebandWithRetry(credential, callId, sessionId);
    }
  }
  const upstream = upstreamResponse.webSocket;
  if (!upstream) {
    const detail = await upstreamResponseDetail(upstreamResponse);
    await releaseSubscriptionLease(env, credential);
    return new Response(
      `Realtime sideband upgrade failed with HTTP ${upstreamResponse.status}: ${detail}`,
      { status: 502 },
    );
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  upstream.accept();
  server.accept();
  bridge(server, upstream, () => {
    void releaseSubscriptionLease(env, credential);
  });
  return new Response(null, { status: 101, webSocket: client });
}

async function openRealtimeSidebandWithRetry(
  credential: SubscriptionCredential,
  callId: string,
  sessionId: string,
): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await openRealtimeSideband(credential, callId, sessionId);
    if (response.webSocket || response.status === 401) return response;
    if (attempt < 3) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
  return response!;
}

function openRealtimeSideband(
  credential: SubscriptionCredential,
  callId: string,
  sessionId: string,
): Promise<Response> {
  return fetch(`${REALTIME_SIDEBAND_URL}/${encodeURIComponent(callId)}`, {
    headers: {
      Upgrade: "websocket",
      ...openAiHeaders(credential),
      "openai-alpha": "quicksilver=v2",
      "x-oai-attestation": '{"v":1,"s":1}',
      "x-session-id": sessionId,
      "session-id": sessionId,
      "thread-id": sessionId,
      originator: "nanocodex",
      "User-Agent": "nanocodex/0.1.0",
    },
  });
}

async function validateToolRequest(
  request: Request,
  env: WorkerEnv,
  url: URL,
  operation: Extract<ChatGptOperation, "search" | "image">,
): Promise<Credential | Response> {
  if (!sameOrigin(request, url, env)) return json({ error: "forbidden" }, { status: 403 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "expected JSON" }, { status: 415 });
  }
  const resolved = await resolveCredential(request, env, operation);
  if (resolved instanceof Response) return resolved;
  if (!resolved) return json({ error: "OpenAI credentials are not configured" }, { status: 503 });
  return await limitAgentOperation(env, resolved.actorId, operation) ?? resolved;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  const body = await request.text();
  if (body.length > MAX_JSON_BODY_CHARS) return json({ error: "request body is too large" }, { status: 413 });
  try {
    const decoded = JSON.parse(body);
    return asObject(decoded) ?? json({ error: "expected a JSON object" }, { status: 400 });
  } catch {
    return json({ error: "invalid JSON" }, { status: 400 });
  }
}

function hasWebOperation(commands: Record<string, unknown>): boolean {
  return ["search_query", "image_query", "open", "click", "find", "finance", "weather", "sports", "time"]
    .some((key) => Array.isArray(commands[key]) && commands[key].length > 0);
}

function openAiHeaders(credential: Credential): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.kind === "chatgpt" ? credential.accessToken : credential.apiKey}`,
    "content-type": "application/json",
    "User-Agent": "nanocodex-web/0.1.0",
  };
  if (credential.kind === "chatgpt") {
    headers.originator = CODEX_ORIGINATOR;
    headers["User-Agent"] = CODEX_USER_AGENT;
    headers["ChatGPT-Account-ID"] = credential.accountId;
    if (credential.fedramp) headers["X-OpenAI-Fedramp"] = "true";
  }
  return headers;
}

function fetchOpenAi(
  credential: Credential,
  env: WorkerEnv,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return credential.kind === "chatgpt"
    ? fetchChatGpt(env, url, init, credential.sessionId)
    : fetch(url, init);
}

function upstreamError(operation: string, status: number, body: string): Response {
  let message = body.trimStart().startsWith("<") ? `HTTP ${status}` : body.slice(0, 4_096);
  try {
    const parsed = asObject(JSON.parse(body));
    const error = asObject(parsed?.error);
    if (typeof error?.message === "string") message = error.message;
  } catch { /* Use the bounded response body. */ }
  return json({ error: `${operation} failed: ${message || `HTTP ${status}`}` }, { status: 502 });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function upgradeResponsesWebSocket(
  request: Request,
  env: WorkerEnv,
  url: URL,
  context?: ExecutionContext,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  if (!sameOrigin(request, url, env)) {
    return new Response("Forbidden", { status: 403 });
  }
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId || !/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) {
    return new Response("Invalid session", { status: 400 });
  }
  const leaseId = randomSessionId();
  const resolved = await resolveCredential(request, env, "socket", leaseId);
  if (resolved instanceof Response) return webSocketError(resolved);
  let credential = resolved;
  if (!credential) {
    return new Response("OpenAI credentials are not configured", { status: 503 });
  }
  const limited = await limitAgentOperation(env, credential.actorId, "socket");
  if (limited) {
    await releaseSubscriptionLease(env, credential);
    return webSocketError(limited);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await openResponsesWebSocket(
      env,
      credential,
      sessionId,
      chatGptApiBaseUrl(env),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("OpenAI WebSocket upgrade request failed", { detail });
    await releaseSubscriptionLease(env, credential);
    return new Response(`OpenAI WebSocket upgrade request failed: ${detail}`, { status: 502 });
  }
  if (credential.kind === "chatgpt" && upstreamResponse.status === 401) {
    await upstreamResponse.body?.cancel();
    const recovered = await recoverSubscriptionCredential(request, env, credential);
    if (recovered) {
      credential = recovered;
      try {
        upstreamResponse = await openResponsesWebSocket(
          env,
          credential,
          sessionId,
          chatGptApiBaseUrl(env),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("OpenAI WebSocket retry request failed", { detail });
        await releaseSubscriptionLease(env, credential);
        return new Response(`OpenAI WebSocket retry request failed: ${detail}`, { status: 502 });
      }
    }
  }
  const upstream = upstreamResponse.webSocket;
  if (!upstream) {
    const detail = await upstreamResponseDetail(upstreamResponse);
    console.error("OpenAI WebSocket upgrade rejected", {
      status: upstreamResponse.status,
      detail,
    });
    await releaseSubscriptionLease(env, credential);
    return new Response(
      `OpenAI WebSocket upgrade failed with HTTP ${upstreamResponse.status}: ${detail}`,
      { status: 502 },
    );
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  upstream.binaryType = "arraybuffer";
  upstream.accept();
  server.accept();
  bridge(server, upstream, () => {
    const release = releaseSubscriptionLease(env, credential);
    if (context) context.waitUntil(release);
    else void release;
  });
  return new Response(null, { status: 101, webSocket: client });
}

async function upstreamResponseDetail(response: Response): Promise<string> {
  const body = await readBoundedResponse(response, 4_096);
  try {
    const parsed = asObject(JSON.parse(body));
    const error = asObject(parsed?.error);
    if (typeof error?.message === "string") return error.message.slice(0, 1_024);
    if (typeof parsed?.detail === "string") return parsed.detail.slice(0, 1_024);
  } catch { /* Fall through to the bounded text classification. */ }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("text/plain") && !body.trimStart().startsWith("<")) {
    return body.slice(0, 1_024);
  }
  return `HTTP ${response.status}`;
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    total += value.byteLength;
    if (total > limit) {
      const remaining = Math.max(0, limit - (total - value.byteLength));
      body += decoder.decode(value.subarray(0, remaining));
      await reader.cancel();
      return `${body}…`;
    }
    body += decoder.decode(value, { stream: true });
  }
}

function openResponsesWebSocket(
  env: WorkerEnv,
  credential: Credential,
  sessionId: string,
  chatGptBaseUrl: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    Authorization: `Bearer ${credential.kind === "chatgpt" ? credential.accessToken : credential.apiKey}`,
    "OpenAI-Beta": RESPONSES_WEBSOCKETS_BETA,
    "x-openai-internal-codex-responses-lite": "true",
    "session-id": sessionId,
    "thread-id": sessionId,
    "x-client-request-id": sessionId,
    "x-responsesapi-include-timing-metrics": "true",
    originator: CODEX_ORIGINATOR,
    "User-Agent": CODEX_USER_AGENT,
  };
  if (credential.kind === "chatgpt") {
    headers["ChatGPT-Account-ID"] = credential.accountId;
    if (credential.fedramp) headers["X-OpenAI-Fedramp"] = "true";
  }
  return credential.kind === "chatgpt"
    ? fetchChatGpt(env, `${chatGptBaseUrl}/responses`, { headers }, credential.sessionId)
    : fetch(RESPONSES_UPGRADE_URL, { headers });
}

function chatGptApiBaseUrl(env: WorkerEnv): string {
  return env.ENVIRONMENT === "development"
    ? LOCAL_CHATGPT_API_BASE_URL
    : CHATGPT_API_BASE_URL;
}

async function startChatGptSession(
  request: Request,
  env: WorkerEnv,
  url: URL,
): Promise<Response> {
  if (!sameOrigin(request, url, env)) return json({ error: "forbidden" }, { status: 403 });
  if (!env.CHATGPT_SESSIONS) {
    return json({ error: "ChatGPT subscription login is not configured" }, { status: 503 });
  }
  const limited = await limitLoginStart(request, env);
  if (limited) return limited;
  await deleteChatGptSession(request, env);
  const sessionId = randomSessionId();
  const response = await chatGptStub(env, sessionId).fetch("https://chatgpt.internal/start", {
    method: "POST",
  });
  return new Response(response.body, {
    status: response.status,
    headers: response.ok
      ? responseHeaders(response, {
          "set-cookie": chatGptSessionCookie(sessionId, url, CHATGPT_LOGIN_TTL_MS),
        })
      : responseHeaders(response),
  });
}

async function chatGptSessionStatus(
  request: Request,
  env: WorkerEnv,
  context?: ExecutionContext,
): Promise<Response> {
  if (!env.CHATGPT_SESSIONS) {
    return json({ error: "ChatGPT subscription login is not configured" }, { status: 503 });
  }
  const sessionId = chatGptSessionIdFromRequest(request);
  if (!sessionId) return json({ state: "signed_out" });
  const limited = await limitSessionPoll(env, sessionId);
  if (limited) return limited;
  const response = await chatGptStub(env, sessionId).fetch("https://chatgpt.internal/status");
  const body = await response.text();
  const state = response.ok ? parseState(body) : undefined;
  const extra: Record<string, string> = {};
  if (state === "authenticated") {
    extra["set-cookie"] = chatGptSessionCookie(sessionId, new URL(request.url), CHATGPT_SESSION_TTL_MS);
    if (context) context.waitUntil(warmChatGptEgress(env, sessionId));
  }
  return new Response(body, {
    status: response.status,
    headers: responseHeaders(response, extra),
  });
}

async function clearChatGptSession(
  request: Request,
  env: WorkerEnv,
  url: URL,
): Promise<Response> {
  if (!sameOrigin(request, url, env)) return json({ error: "forbidden" }, { status: 403 });
  await deleteChatGptSession(request, env);
  return json({ state: "signed_out" }, {
    headers: { "set-cookie": clearChatGptSessionCookie(url) },
  });
}

function responseHeaders(response: Response, extra?: Record<string, string>): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": response.headers.get("content-type") ?? "application/json",
    "x-content-type-options": "nosniff",
  });
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  return headers;
}

function parseState(body: string): string | undefined {
  try {
    const value = asObject(JSON.parse(body));
    return typeof value?.state === "string" ? value.state : undefined;
  } catch {
    return undefined;
  }
}

function webSocketError(response: Response): Response {
  return response;
}

async function createByokSession(
  request: Request,
  env: WorkerEnv,
  url: URL,
): Promise<Response> {
  if (!sameOrigin(request, url, env)) return json({ error: "forbidden" }, { status: 403 });
  if (!env.BYOK_SESSIONS) return json({ error: "BYOK sessions are not configured" }, { status: 503 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "expected JSON" }, { status: 415 });
  }
  const body = await request.text();
  if (body.length > 4_096) return json({ error: "request body is too large" }, { status: 413 });
  let apiKey: unknown;
  try {
    apiKey = asObject(JSON.parse(body))?.api_key;
  } catch {
    return json({ error: "invalid JSON" }, { status: 400 });
  }
  const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!normalizedApiKey || normalizedApiKey.length > MAX_API_KEY_CHARS) {
    return json({ error: "api_key must be a non-empty string of at most 1024 characters" }, { status: 400 });
  }

  const sessionId = randomSessionId();
  const stub = env.BYOK_SESSIONS.get(env.BYOK_SESSIONS.idFromName(sessionId));
  const stored = await stub.fetch("https://byok.internal/credential", {
    method: "PUT",
    body: normalizedApiKey,
  });
  if (!stored.ok) return json({ error: "failed to create BYOK session" }, { status: 503 });
  await deleteSession(request, env);
  return json(
    { agent_configured: true, credential_source: "user", expires_in: BYOK_SESSION_TTL_MS / 1_000 },
    { headers: { "set-cookie": sessionCookie(sessionId, url) } },
  );
}

async function clearByokSession(
  request: Request,
  env: WorkerEnv,
  url: URL,
): Promise<Response> {
  if (!sameOrigin(request, url, env)) return json({ error: "forbidden" }, { status: 403 });
  await deleteSession(request, env);
  const credential = deploymentCredentialEnabled(env)
    ? { agent_configured: true, credential_source: "deployment" }
    : { agent_configured: false, credential_source: null };
  return json(credential, { headers: { "set-cookie": clearSessionCookie(url) } });
}

function deploymentCredentialEnabled(env: WorkerEnv): boolean {
  return Boolean(env.OPENAI_API_KEY)
    && env.ENVIRONMENT !== "production"
    && env.ENVIRONMENT !== "preview";
}

async function resolveCredential(
  request: Request,
  env: WorkerEnv,
  operation: ChatGptOperation,
  leaseId?: string,
): Promise<Credential | Response | undefined> {
  const subscription = await resolveSubscriptionCredential(request, env, operation, leaseId);
  if (subscription) return subscription;
  const sessionId = sessionIdFromRequest(request);
  if (sessionId && env.BYOK_SESSIONS) {
    try {
      const stub = env.BYOK_SESSIONS.get(env.BYOK_SESSIONS.idFromName(sessionId));
      const response = await stub.fetch("https://byok.internal/credential");
      if (response.ok) {
        const apiKey = await response.text();
        if (apiKey) {
          return {
            kind: "api_key",
            apiKey,
            actorId: await apiKeyActorId(apiKey),
            source: "user",
          };
        }
      }
    } catch { /* Fall through to a development-only deployment credential. */ }
  }
  return deploymentCredentialEnabled(env)
    ? {
        kind: "api_key",
        apiKey: env.OPENAI_API_KEY!,
        actorId: await apiKeyActorId(env.OPENAI_API_KEY!),
        source: "deployment",
      }
    : undefined;
}

async function resolveSubscriptionCredential(
  request: Request,
  env: WorkerEnv,
  operation: ChatGptOperation,
  leaseId?: string,
): Promise<SubscriptionCredential | Response | undefined> {
  const sessionId = chatGptSessionIdFromRequest(request);
  if (!sessionId || !env.CHATGPT_SESSIONS) return undefined;
  try {
    const response = await chatGptStub(env, sessionId).fetch("https://chatgpt.internal/credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, ...(leaseId ? { leaseId } : {}) }),
    });
    if (!response.ok) {
      if (response.status === 429) {
        return new Response(response.body, {
          status: 429,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
            "retry-after": response.headers.get("retry-after") ?? "60",
          },
        });
      }
      await response.body?.cancel();
      return undefined;
    }
    const credential = await response.json<ChatGptCredential>();
    return isChatGptCredential(credential)
      ? {
          ...credential,
          actorId: `chatgpt:${credential.accountId}`,
          sessionId,
          ...(leaseId ? { leaseId } : {}),
          source: "subscription",
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function recoverSubscriptionCredential(
  request: Request,
  env: WorkerEnv,
  previous: SubscriptionCredential,
): Promise<SubscriptionCredential | undefined> {
  const sessionId = chatGptSessionIdFromRequest(request);
  if (!sessionId || !env.CHATGPT_SESSIONS) return undefined;
  try {
    const response = await chatGptStub(env, sessionId).fetch("https://chatgpt.internal/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: previous.revision }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const credential = await response.json<ChatGptCredential>();
    return isChatGptCredential(credential)
      ? {
          ...credential,
          actorId: previous.actorId,
          sessionId: previous.sessionId,
          ...(previous.leaseId ? { leaseId: previous.leaseId } : {}),
          source: "subscription",
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function releaseSubscriptionLease(
  env: WorkerEnv,
  credential: Credential,
): Promise<void> {
  if (credential.kind !== "chatgpt" || !credential.leaseId || !env.CHATGPT_SESSIONS) return;
  try {
    const response = await chatGptStub(env, credential.sessionId).fetch(
      "https://chatgpt.internal/lease",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseId: credential.leaseId }),
      },
    );
    await response.body?.cancel();
  } catch { /* The lease expires automatically if cleanup cannot be delivered. */ }
}

function isChatGptCredential(value: unknown): value is ChatGptCredential {
  const credential = asObject(value);
  return credential?.kind === "chatgpt"
    && typeof credential.accessToken === "string"
    && credential.accessToken.length > 0
    && typeof credential.accountId === "string"
    && credential.accountId.length > 0
    && typeof credential.fedramp === "boolean"
    && Number.isSafeInteger(credential.revision)
    && Number(credential.revision) >= 0;
}

async function deleteSession(request: Request, env: WorkerEnv): Promise<void> {
  const sessionId = sessionIdFromRequest(request);
  if (!sessionId || !env.BYOK_SESSIONS) return;
  const stub = env.BYOK_SESSIONS.get(env.BYOK_SESSIONS.idFromName(sessionId));
  await stub.fetch("https://byok.internal/credential", { method: "DELETE" });
}

function sessionIdFromRequest(request: Request): string | undefined {
  return cookieSessionId(request, [SECURE_BYOK_COOKIE, BYOK_COOKIE]);
}

function chatGptSessionIdFromRequest(request: Request): string | undefined {
  return cookieSessionId(request, [SECURE_CHATGPT_COOKIE, CHATGPT_COOKIE]);
}

function cookieSessionId(request: Request, cookieNames: readonly string[]): string | undefined {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!cookieNames.includes(name ?? "")) continue;
    const value = rest.join("=");
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function sessionCookie(sessionId: string, url: URL): string {
  const secure = url.protocol === "https:";
  const name = secure ? SECURE_BYOK_COOKIE : BYOK_COOKIE;
  return `${name}=${sessionId}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${BYOK_SESSION_TTL_MS / 1_000}${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(url: URL): string {
  const secure = url.protocol === "https:";
  const name = secure ? SECURE_BYOK_COOKIE : BYOK_COOKIE;
  return `${name}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function chatGptSessionCookie(sessionId: string, url: URL, ttlMs: number): string {
  const secure = url.protocol === "https:";
  const name = secure ? SECURE_CHATGPT_COOKIE : CHATGPT_COOKIE;
  return `${name}=${sessionId}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${ttlMs / 1_000}${secure ? "; Secure" : ""}`;
}

function clearChatGptSessionCookie(url: URL): string {
  const secure = url.protocol === "https:";
  const name = secure ? SECURE_CHATGPT_COOKIE : CHATGPT_COOKIE;
  return `${name}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function chatGptStub(env: WorkerEnv, sessionId: string): DurableObjectStub {
  if (!env.CHATGPT_SESSIONS) throw new Error("ChatGPT subscription login is not configured");
  return env.CHATGPT_SESSIONS.get(env.CHATGPT_SESSIONS.idFromName(sessionId));
}

async function deleteChatGptSession(request: Request, env: WorkerEnv): Promise<void> {
  const sessionId = chatGptSessionIdFromRequest(request);
  if (!sessionId || !env.CHATGPT_SESSIONS) return;
  await chatGptStub(env, sessionId).fetch("https://chatgpt.internal/session", { method: "DELETE" });
}

function sameOrigin(request: Request, url: URL, env: WorkerEnv): boolean {
  const origin = request.headers.get("Origin");
  if (origin) return matchesRequestOrigin(origin, url, env.ENVIRONMENT === "development");
  const referer = request.headers.get("Referer");
  return referer !== null
    && matchesRequestOrigin(referer, url, env.ENVIRONMENT === "development");
}

function matchesRequestOrigin(value: string, url: URL, allowLoopback: boolean): boolean {
  try {
    const source = new URL(value);
    if (source.origin === url.origin) return true;
    if (!allowLoopback) return false;
    const loopback = (hostname: string) => ["localhost", "127.0.0.1", "::1"].includes(hostname);
    return loopback(source.hostname)
      && loopback(url.hostname)
      && ["http:", "https:"].includes(source.protocol)
      && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function bridge(left: WebSocket, right: WebSocket, onClose: () => void): void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  forward(left, right, close);
  forward(right, left, close);
}

function forward(source: WebSocket, destination: WebSocket, onClose: () => void): void {
  source.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      closeSocket(source, 1003, "text frames required");
      closeSocket(destination, 1003, "text frames required");
      return;
    }
    if (event.data.length > MAX_WEBSOCKET_MESSAGE_CHARS) {
      closeSocket(source, 1009, "message too large");
      closeSocket(destination, 1009, "message too large");
      return;
    }
    if (destination.readyState === WebSocket.OPEN) destination.send(event.data);
  });
  source.addEventListener("close", (event) => {
    onClose();
    closeSocket(destination, event.code, event.reason || "peer closed");
  });
  source.addEventListener("error", () => {
    onClose();
    closeSocket(destination, 1011, "peer WebSocket failed");
  });
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN) return;
  const safeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011;
  socket.close(safeCode, reason.slice(0, 120));
}

export class ByokSession {
  readonly #state: DurableObjectState;
  readonly #vault: CredentialVault;

  constructor(state: DurableObjectState, env: CredentialVaultEnv) {
    this.#state = state;
    this.#vault = new CredentialVault(env, `byok/${state.id?.toString() ?? "test"}`);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "PUT") {
      const apiKey = await request.text();
      if (!apiKey || apiKey.length > MAX_API_KEY_CHARS) return new Response(null, { status: 400 });
      const credential: StoredCredential = {
        apiKey,
        expiresAt: Date.now() + BYOK_SESSION_TTL_MS,
      };
      await this.#state.storage.put("credential", await this.#vault.seal(credential));
      await this.#state.storage.setAlarm(credential.expiresAt);
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      await this.#state.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    const envelope = await this.#state.storage.get<EncryptedEnvelope>("credential");
    const opened = envelope ? await this.#vault.open<StoredCredential>(envelope) : undefined;
    const credential = opened?.value;
    if (!credential || credential.expiresAt <= Date.now()) {
      if (envelope) await this.#state.storage.deleteAll();
      return new Response(null, { status: 404 });
    }
    if (opened.reseal) {
      await this.#state.storage.put("credential", await this.#vault.seal(credential));
    }
    return new Response(credential.apiKey, {
      headers: { "cache-control": "no-store", "content-type": "text/plain" },
    });
  }

  async alarm(): Promise<void> {
    await this.#state.storage.deleteAll();
  }
}
