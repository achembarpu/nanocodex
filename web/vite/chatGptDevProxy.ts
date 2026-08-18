import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, type Duplex } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Plugin } from "vite";
import WebSocket, { WebSocketServer } from "ws";

export const CHATGPT_DEV_PROXY_ORIGIN = "http://127.0.0.1:8791";

const CHATGPT_HOST = "chatgpt.com";
const CHATGPT_PATH_PREFIX = "/backend-api/codex/";
const proxyGlobal = globalThis as typeof globalThis & {
  __nanocodexChatGptDevProxy?: ReturnType<typeof createServer>;
};

export function chatGptDevProxy(): Plugin {
  return {
    name: "nanocodex-chatgpt-dev-proxy",
    apply: "serve",
    configureServer(vite) {
      const proxy = createServer(proxyHttpRequest);
      const downstreamServer = new WebSocketServer({ noServer: true });
      proxy.on("upgrade", (request, socket, head) => {
        proxyWebSocketUpgrade(request, socket, head, downstreamServer, (message) => {
          vite.config.logger.warn(message);
        });
      });
      proxy.on("clientError", (_error, socket) => {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      });
      proxy.on("error", (error) => {
        vite.config.logger.error(`ChatGPT development proxy failed: ${error.message}`);
      });
      const listen = () => proxy.listen(Number(new URL(CHATGPT_DEV_PROXY_ORIGIN).port), "127.0.0.1");
      const previous = proxyGlobal.__nanocodexChatGptDevProxy;
      if (previous?.listening) previous.close(listen);
      else listen();
      proxyGlobal.__nanocodexChatGptDevProxy = proxy;

      vite.httpServer?.once("close", () => {
        proxy.close();
        if (proxyGlobal.__nanocodexChatGptDevProxy === proxy) {
          proxyGlobal.__nanocodexChatGptDevProxy = undefined;
        }
      });
    },
  };
}

async function proxyHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isAllowedPath(request.url)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const method = request.method ?? "GET";
    const upstream = await fetch(`https://${CHATGPT_HOST}${request.url}`, {
      method,
      headers: upstreamHttpHeaders(request),
      body: method === "GET" || method === "HEAD"
        ? undefined
        : Readable.toWeb(request) as BodyInit,
      duplex: "half",
      redirect: "manual",
    } as RequestInit & { duplex: "half" });
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    response.writeHead(upstream.status, upstream.statusText, Object.fromEntries(headers));
    if (upstream.body) {
      Readable.fromWeb(upstream.body as unknown as NodeReadableStream).pipe(response);
    }
    else response.end();
  } catch {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  }
}

function proxyWebSocketUpgrade(
  request: IncomingMessage,
  client: Duplex,
  clientHead: Buffer,
  downstreamServer: WebSocketServer,
  warn: (message: string) => void,
): void {
  client.on("error", () => {});
  if (!isAllowedPath(request.url)) {
    client.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = new WebSocket(`wss://${CHATGPT_HOST}${request.url}`, {
    headers: upstreamWebSocketHeaders(request),
  });
  upstream.once("open", () => {
    try {
      downstreamServer.handleUpgrade(request, client, clientHead, (downstream) => {
        bridgeWebSockets(downstream, upstream);
      });
    } catch (error) {
      warn(`ChatGPT development proxy could not accept the downstream WebSocket: ${safeMessage(error)}`);
      upstream.terminate();
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  });
  upstream.once("unexpected-response", (_request, response) => {
    warn(
      `ChatGPT WebSocket upgrade returned HTTP ${response.statusCode ?? 502}`
      + diagnosticHeaderSuffix(response),
    );
    response.resume();
    const status = response.statusCode ?? 502;
    const body = `ChatGPT WebSocket upgrade returned HTTP ${status}`;
    client.end(
      `HTTP/1.1 ${status} ${response.statusMessage ?? "Upstream Error"}\r\n`
      + "Content-Type: text/plain; charset=utf-8\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "Connection: close\r\n\r\n"
      + body,
    );
  });
  upstream.once("error", (error) => {
    if (!client.destroyed) {
      warn(`ChatGPT WebSocket upgrade failed: ${safeMessage(error)}`);
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  });
}

function bridgeWebSockets(downstream: WebSocket, upstream: WebSocket): void {
  downstream.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });
  upstream.on("message", (data, isBinary) => {
    if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
  });
  downstream.on("close", (code, reason) => closeWebSocket(upstream, code, reason));
  upstream.on("close", (code, reason) => closeWebSocket(downstream, code, reason));
  downstream.on("error", () => upstream.terminate());
  upstream.on("error", () => downstream.terminate());
}

function closeWebSocket(socket: WebSocket, code: number, reason: Buffer): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const validCode = (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
    || (code >= 3000 && code <= 4999);
  if (!validCode) {
    socket.terminate();
    return;
  }
  socket.close(code, reason.subarray(0, 123).toString("utf8"));
}

function diagnosticHeaderSuffix(response: IncomingMessage): string {
  const fields = ["x-oai-request-id", "cf-ray", "cf-mitigated", "content-type"]
    .flatMap((name) => {
      const value = response.headers[name];
      return typeof value === "string" ? [`${name}=${value}`] : [];
    });
  return fields.length > 0 ? ` (${fields.join(", ")})` : "";
}

function isAllowedPath(path: string | undefined): path is string {
  return path?.startsWith(CHATGPT_PATH_PREFIX) === true;
}

function upstreamHttpHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of [
    "accept",
    "authorization",
    "chatgpt-account-id",
    "content-type",
    "openai-alpha",
    "originator",
    "session-id",
    "thread-id",
    "user-agent",
    "x-oai-attestation",
    "x-openai-fedramp",
    "x-session-id",
  ]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

function upstreamWebSocketHeaders(request: IncomingMessage): Record<string, string | string[]> {
  const allowed = new Set([
    "authorization",
    "chatgpt-account-id",
    "openai-beta",
    "originator",
    "session-id",
    "thread-id",
    "user-agent",
    "x-client-request-id",
    "x-openai-fedramp",
    "x-openai-internal-codex-responses-lite",
    "x-responsesapi-include-timing-metrics",
  ]);
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined || !allowed.has(name) ? [] : [[name, value]]),
  );
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
