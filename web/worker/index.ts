import { ChatGptSession, type ChatGptCredential } from "./subscriptionAuth.ts";

export { ChatGptSession };

const json = (body: unknown, init?: ResponseInit) =>
  Response.json(body, {
    ...init,
    headers: {
      "cache-control": "no-store",
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
const BYOK_SESSION_TTL_MS = 60 * 60 * 1_000;
const CHATGPT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const BYOK_COOKIE = "nanocodex_byok";
const CHATGPT_COOKIE = "nanocodex_chatgpt";

type WorkerEnv = {
  ENVIRONMENT: string;
  OPENAI_API_KEY?: string;
  CHATGPT_ISSUER?: string;
  EVALS_API_ORIGIN?: string;
  EVALS_ACCESS_CLIENT_ID?: string;
  EVALS_ACCESS_CLIENT_SECRET?: string;
  BYOK_SESSIONS?: DurableObjectNamespace;
  CHATGPT_SESSIONS?: DurableObjectNamespace;
};

type ApiKeyCredential = { kind: "api_key"; apiKey: string; source: "user" | "deployment" };
type SubscriptionCredential = ChatGptCredential & { source: "subscription" };
type Credential = ApiKeyCredential | SubscriptionCredential;
type StoredCredential = { apiKey: string; expiresAt: number };

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/api/evals" || url.pathname.startsWith("/api/evals/"))
    ) {
      return proxyEvals(request, env, url);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      const credential = await resolveCredential(request, env);
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
      return chatGptSessionStatus(request, env);
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
      return upgradeResponsesWebSocket(request, env, url);
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

async function proxyEvals(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const configuredOrigin = env.EVALS_API_ORIGIN
    ?? (env.ENVIRONMENT === "development" ? "http://127.0.0.1:8788" : undefined);
  if (!configuredOrigin) {
    return json({ error: "evaluation API is not configured" }, { status: 503 });
  }
  let upstream: URL;
  try {
    upstream = new URL(configuredOrigin);
  } catch {
    return json({ error: "evaluation API origin is invalid" }, { status: 500 });
  }
  const developmentLoopback = env.ENVIRONMENT === "development"
    && upstream.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(upstream.hostname);
  if (upstream.protocol !== "https:" && !developmentLoopback) {
    return json({ error: "evaluation API origin must use HTTPS" }, { status: 500 });
  }
  upstream.pathname = `/v1${url.pathname.slice("/api".length)}`;
  upstream.search = url.search;
  const headers = new Headers({ accept: "application/json" });
  if (Boolean(env.EVALS_ACCESS_CLIENT_ID) !== Boolean(env.EVALS_ACCESS_CLIENT_SECRET)) {
    return json({ error: "evaluation API Access credentials are incomplete" }, { status: 500 });
  }
  if (env.EVALS_ACCESS_CLIENT_ID && env.EVALS_ACCESS_CLIENT_SECRET) {
    headers.set("CF-Access-Client-Id", env.EVALS_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.EVALS_ACCESS_CLIENT_SECRET);
  }
  const response = await fetch(upstream, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: request.signal,
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "cache-control": "no-store",
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

async function proxyWebSearch(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const credential = await validateToolRequest(request, env, url);
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
  const upstream = await fetch(
    credential.kind === "chatgpt"
      ? `${chatGptApiBaseUrl(env)}/alpha/search`
      : WEB_SEARCH_URL,
    {
      method: "POST",
      headers: openAiHeaders(credential),
      body: JSON.stringify({
        id: sessionId,
        model: MODEL,
        commands,
        settings: { allowed_callers: ["direct"], external_web_access: true },
        max_output_tokens: 10_000,
      }),
    },
  );
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
  const credential = await validateToolRequest(request, env, url);
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
  const upstream = await fetch(imageUrl, {
    method: "POST",
    headers: openAiHeaders(credential),
    body: JSON.stringify({
      ...(images.length ? { images: images.map((image_url) => ({ image_url })) } : {}),
      prompt,
      background: "auto",
      model: IMAGE_MODEL,
      quality: "auto",
      size: "auto",
    }),
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
  if (!sameOrigin(request, url)) return json({ error: "forbidden" }, { status: 403 });
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
  let credential = await resolveSubscriptionCredential(request, env);
  if (!credential) {
    return json({ error: "voice requires an authenticated ChatGPT subscription" }, { status: 503 });
  }
  let upstream = await openRealtimeCall(credential, env, sdp, sessionId, voice);
  if (upstream.status === 401) {
    await upstream.body?.cancel();
    const recovered = await recoverSubscriptionCredential(request, env, credential.revision);
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
  if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
  const callId = url.searchParams.get("call_id") ?? "";
  const sessionId = url.searchParams.get("session_id") ?? "";
  if (!realtimeCallId(callId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) {
    return new Response("Invalid Realtime session", { status: 400 });
  }
  let credential = await resolveSubscriptionCredential(request, env);
  if (!credential) {
    return new Response("Voice requires an authenticated ChatGPT subscription", { status: 503 });
  }

  let upstreamResponse = await openRealtimeSidebandWithRetry(credential, callId, sessionId);
  if (upstreamResponse.status === 401) {
    await upstreamResponse.body?.cancel();
    const recovered = await recoverSubscriptionCredential(request, env, credential.revision);
    if (recovered) {
      credential = recovered;
      upstreamResponse = await openRealtimeSidebandWithRetry(credential, callId, sessionId);
    }
  }
  const upstream = upstreamResponse.webSocket;
  if (!upstream) {
    const detail = await upstreamResponseDetail(upstreamResponse);
    return new Response(
      `Realtime sideband upgrade failed with HTTP ${upstreamResponse.status}: ${detail}`,
      { status: 502 },
    );
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  upstream.accept();
  server.accept();
  bridge(server, upstream);
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
): Promise<Credential | Response> {
  if (!sameOrigin(request, url)) return json({ error: "forbidden" }, { status: 403 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "expected JSON" }, { status: 415 });
  }
  return await resolveCredential(request, env)
    ?? json({ error: "OpenAI credentials are not configured" }, { status: 503 });
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
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  if (!sameOrigin(request, url)) {
    return new Response("Forbidden", { status: 403 });
  }
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId || !/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) {
    return new Response("Invalid session", { status: 400 });
  }
  let credential = await resolveCredential(request, env);
  if (!credential) {
    return new Response("OpenAI credentials are not configured", { status: 503 });
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await openResponsesWebSocket(
      credential,
      sessionId,
      chatGptApiBaseUrl(env),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("OpenAI WebSocket upgrade request failed", { detail });
    return new Response(`OpenAI WebSocket upgrade request failed: ${detail}`, { status: 502 });
  }
  if (credential.kind === "chatgpt" && upstreamResponse.status === 401) {
    await upstreamResponse.body?.cancel();
    const recovered = await recoverSubscriptionCredential(request, env, credential.revision);
    if (recovered) {
      credential = recovered;
      try {
        upstreamResponse = await openResponsesWebSocket(
          credential,
          sessionId,
          chatGptApiBaseUrl(env),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("OpenAI WebSocket retry request failed", { detail });
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
  bridge(server, upstream);
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
  return fetch(
    credential.kind === "chatgpt" ? `${chatGptBaseUrl}/responses` : RESPONSES_UPGRADE_URL,
    { headers },
  );
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
  if (!sameOrigin(request, url)) return json({ error: "forbidden" }, { status: 403 });
  if (!env.CHATGPT_SESSIONS) {
    return json({ error: "ChatGPT subscription login is not configured" }, { status: 503 });
  }
  await deleteChatGptSession(request, env);
  const sessionId = randomSessionId();
  const response = await chatGptStub(env, sessionId).fetch("https://chatgpt.internal/start", {
    method: "POST",
  });
  return new Response(response.body, {
    status: response.status,
    headers: response.ok
      ? responseHeaders(response, { "set-cookie": chatGptSessionCookie(sessionId, url) })
      : responseHeaders(response),
  });
}

async function chatGptSessionStatus(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.CHATGPT_SESSIONS) {
    return json({ error: "ChatGPT subscription login is not configured" }, { status: 503 });
  }
  const sessionId = chatGptSessionIdFromRequest(request);
  if (!sessionId) return json({ state: "signed_out" });
  const response = await chatGptStub(env, sessionId).fetch("https://chatgpt.internal/status");
  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders(response),
  });
}

async function clearChatGptSession(
  request: Request,
  env: WorkerEnv,
  url: URL,
): Promise<Response> {
  if (!sameOrigin(request, url)) return json({ error: "forbidden" }, { status: 403 });
  await deleteChatGptSession(request, env);
  return json({ state: "signed_out" }, {
    headers: { "set-cookie": clearChatGptSessionCookie(url) },
  });
}

function responseHeaders(response: Response, extra?: Record<string, string>): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": response.headers.get("content-type") ?? "application/json",
  });
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  return headers;
}

async function createByokSession(
  request: Request,
  env: WorkerEnv,
  url: URL,
): Promise<Response> {
  if (!sameOrigin(request, url)) return json({ error: "forbidden" }, { status: 403 });
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
  if (!sameOrigin(request, url)) return json({ error: "forbidden" }, { status: 403 });
  await deleteSession(request, env);
  const credential = env.OPENAI_API_KEY
    ? { agent_configured: true, credential_source: "deployment" }
    : { agent_configured: false, credential_source: null };
  return json(credential, { headers: { "set-cookie": clearSessionCookie(url) } });
}

async function resolveCredential(request: Request, env: WorkerEnv): Promise<Credential | undefined> {
  const subscription = await resolveSubscriptionCredential(request, env);
  if (subscription) return subscription;
  const sessionId = sessionIdFromRequest(request);
  if (sessionId && env.BYOK_SESSIONS) {
    try {
      const stub = env.BYOK_SESSIONS.get(env.BYOK_SESSIONS.idFromName(sessionId));
      const response = await stub.fetch("https://byok.internal/credential");
      if (response.ok) {
        const apiKey = await response.text();
        if (apiKey) return { kind: "api_key", apiKey, source: "user" };
      }
    } catch { /* A deployment credential remains a valid fallback. */ }
  }
  return env.OPENAI_API_KEY
    ? { kind: "api_key", apiKey: env.OPENAI_API_KEY, source: "deployment" }
    : undefined;
}

async function resolveSubscriptionCredential(
  request: Request,
  env: WorkerEnv,
): Promise<SubscriptionCredential | undefined> {
  const sessionId = chatGptSessionIdFromRequest(request);
  if (!sessionId || !env.CHATGPT_SESSIONS) return undefined;
  try {
    const response = await chatGptStub(env, sessionId).fetch("https://chatgpt.internal/credential", {
      method: "POST",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const credential = await response.json<ChatGptCredential>();
    return isChatGptCredential(credential) ? { ...credential, source: "subscription" } : undefined;
  } catch {
    return undefined;
  }
}

async function recoverSubscriptionCredential(
  request: Request,
  env: WorkerEnv,
  revision: number,
): Promise<SubscriptionCredential | undefined> {
  const sessionId = chatGptSessionIdFromRequest(request);
  if (!sessionId || !env.CHATGPT_SESSIONS) return undefined;
  try {
    const response = await chatGptStub(env, sessionId).fetch("https://chatgpt.internal/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const credential = await response.json<ChatGptCredential>();
    return isChatGptCredential(credential) ? { ...credential, source: "subscription" } : undefined;
  } catch {
    return undefined;
  }
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
  return cookieSessionId(request, BYOK_COOKIE);
}

function chatGptSessionIdFromRequest(request: Request): string | undefined {
  return cookieSessionId(request, CHATGPT_COOKIE);
}

function cookieSessionId(request: Request, cookieName: string): string | undefined {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== cookieName) continue;
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
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${BYOK_COOKIE}=${sessionId}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${BYOK_SESSION_TTL_MS / 1_000}${secure}`;
}

function clearSessionCookie(url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${BYOK_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function chatGptSessionCookie(sessionId: string, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${CHATGPT_COOKIE}=${sessionId}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${CHATGPT_SESSION_TTL_MS / 1_000}${secure}`;
}

function clearChatGptSessionCookie(url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${CHATGPT_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
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

function sameOrigin(request: Request, url: URL): boolean {
  // A custom header protects same-origin fetches even when the local Cloudflare
  // Vite bridge rewrites the public URL before dispatching to the Worker.
  if (request.headers.get("x-nanocodex-request") === "1") return true;
  const origin = request.headers.get("Origin");
  if (origin) return matchesRequestOrigin(origin, url);
  const referer = request.headers.get("Referer");
  return referer !== null && matchesRequestOrigin(referer, url);
}

function matchesRequestOrigin(value: string, url: URL): boolean {
  try {
    const source = new URL(value);
    if (source.origin === url.origin) return true;
    const loopback = (hostname: string) => ["localhost", "127.0.0.1", "::1"].includes(hostname);
    return loopback(source.hostname)
      && loopback(url.hostname)
      && ["http:", "https:"].includes(source.protocol)
      && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function bridge(left: WebSocket, right: WebSocket): void {
  forward(left, right);
  forward(right, left);
}

function forward(source: WebSocket, destination: WebSocket): void {
  source.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      closeSocket(source, 1003, "text frames required");
      closeSocket(destination, 1003, "text frames required");
      return;
    }
    if (destination.readyState === WebSocket.OPEN) destination.send(event.data);
  });
  source.addEventListener("close", (event) => {
    closeSocket(destination, event.code, event.reason || "peer closed");
  });
  source.addEventListener("error", () => {
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

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "PUT") {
      const apiKey = await request.text();
      if (!apiKey || apiKey.length > MAX_API_KEY_CHARS) return new Response(null, { status: 400 });
      const credential: StoredCredential = {
        apiKey,
        expiresAt: Date.now() + BYOK_SESSION_TTL_MS,
      };
      await this.#state.storage.put("credential", credential);
      await this.#state.storage.setAlarm(credential.expiresAt);
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      await this.#state.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    const credential = await this.#state.storage.get<StoredCredential>("credential");
    if (!credential || credential.expiresAt <= Date.now()) {
      if (credential) await this.#state.storage.deleteAll();
      return new Response(null, { status: 404 });
    }
    return new Response(credential.apiKey, {
      headers: { "cache-control": "no-store", "content-type": "text/plain" },
    });
  }

  async alarm(): Promise<void> {
    await this.#state.storage.deleteAll();
  }
}
