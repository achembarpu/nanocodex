export interface AgentEnv {
  EGRESS: Fetcher;
  AGENT_TOKEN: string;
}

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const MAX_UPSTREAM_ERROR_BYTES = 4 * 1024;

export default {
  fetch(request: Request, env: AgentEnv): Promise<Response> {
    return handleAgent(request, env);
  },
} satisfies ExportedHandler<AgentEnv>;

export async function handleAgent(request: Request, env: AgentEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok", service: "nanocodex-egress-agent" });
  }
  if (!env.AGENT_TOKEN) return jsonError(503, "agent_not_configured");
  if (request.headers.get("authorization") !== `Bearer ${env.AGENT_TOKEN}`) {
    return jsonError(401, "unauthorized");
  }

  if (request.method === "GET" && url.pathname === "/") {
    return Response.json({
      service: "nanocodex-egress-agent-example",
      endpoints: ["POST /codex-handshake", "GET /github-user", "GET /blocked"],
    });
  }
  if (request.method === "POST" && url.pathname === "/codex-handshake") {
    return codexHandshake(env.EGRESS);
  }
  if (request.method === "GET" && url.pathname === "/github-user") {
    return env.EGRESS.fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer NANOCODEX_GITHUB_TOKEN",
        "user-agent": "nanocodex-cloudflare-egress-example/0.1.0",
        "x-github-api-version": "2022-11-28",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/blocked") {
    return env.EGRESS.fetch("https://example.com/");
  }
  return jsonError(404, "not_found");
}

async function codexHandshake(egress: Fetcher): Promise<Response> {
  const sessionId = crypto.randomUUID();
  const response = await egress.fetch(CODEX_URL, {
    headers: {
      authorization: "Bearer NANOCODEX_CODEX_OAUTH",
      "chatgpt-account-id": "NANOCODEX_CODEX_ACCOUNT",
      "openai-beta": OPENAI_WEBSOCKET_BETA,
      "session-id": sessionId,
      "thread-id": sessionId,
      upgrade: "websocket",
      "user-agent": "nanocodex-cloudflare-egress-example/0.1.0",
      "x-client-request-id": sessionId,
      "x-openai-internal-codex-responses-lite": "true",
      "x-responsesapi-include-timing-metrics": "true",
    },
  });
  if (!response.webSocket) {
    const upstreamStatus = response.status;
    const encoded = await readBoundedText(response, MAX_UPSTREAM_ERROR_BYTES);
    let error = "upstream_rejected";
    try {
      const detail = JSON.parse(encoded) as { error?: unknown };
      if (typeof detail.error === "string" && /^[a-z0-9_]{1,128}$/.test(detail.error)) {
        error = detail.error;
      }
    } catch {
      // Do not reflect an untrusted upstream response body.
    }
    return Response.json(
      { authenticated: false, error, upstream_status: upstreamStatus },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  response.webSocket.accept();
  response.webSocket.close(1000, "handshake complete");
  return Response.json(
    { authenticated: true, upstream_status: response.status },
    { headers: { "cache-control": "no-store" } },
  );
}

function jsonError(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let decoded = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return decoded + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return "";
      }
      decoded += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
