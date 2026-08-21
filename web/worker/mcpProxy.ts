const MCP_UPSTREAMS = Object.freeze({
  "openai-developer-docs": "https://developers.openai.com/mcp",
  cloudflare: "https://docs.mcp.cloudflare.com/mcp",
  viem: "https://viem.sh/api/mcp",
  vocs: "https://vocs.dev/api/mcp",
});

const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
];
const RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "retry-after",
  "www-authenticate",
];
const METHODS = new Set(["GET", "POST", "DELETE"]);
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export async function proxyDefaultMcp(
  request: Request,
  url: URL,
  authorized: boolean,
): Promise<Response | undefined> {
  const match = /^\/api\/mcp\/([a-z-]+)$/.exec(url.pathname);
  if (!match) return undefined;
  const upstreamBase = MCP_UPSTREAMS[match[1] as keyof typeof MCP_UPSTREAMS];
  if (!upstreamBase) return error("unknown MCP server", 404);
  if (!authorized) return error("forbidden", 403);
  if (!METHODS.has(request.method)) {
    return error("method not allowed", 405, { allow: "GET, POST, DELETE" });
  }

  const bodyResult = request.method === "GET"
    ? { ok: true as const, body: undefined }
    : await readBoundedBody(request);
  if (!bodyResult.ok) return bodyResult.response;

  const upstream = new URL(upstreamBase);
  upstream.search = url.search;
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: bodyResult.body,
    redirect: "follow",
  });
  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

async function readBoundedBody(request: Request): Promise<
  | { ok: true; body: ArrayBuffer | undefined }
  | { ok: false; response: Response }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const normalized = declaredLength.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
      await cancelBody(request, "invalid Content-Length");
      return { ok: false, response: error("invalid Content-Length", 400) };
    }
    const length = Number(normalized);
    if (!Number.isSafeInteger(length) || length > MAX_REQUEST_BYTES) {
      await cancelBody(request, "MCP request body is too large");
      return { ok: false, response: error("MCP request body is too large", 413) };
    }
  }

  if (request.body === null) return { ok: true, body: undefined };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_REQUEST_BYTES - bytes) {
        await reader.cancel("MCP request body is too large").catch(() => undefined);
        return { ok: false, response: error("MCP request body is too large", 413) };
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new ArrayBuffer(bytes);
  const target = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    target.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

async function cancelBody(request: Request, reason: string): Promise<void> {
  await request.body?.cancel(reason).catch(() => undefined);
}

function error(message: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: message }, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
