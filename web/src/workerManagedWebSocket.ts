type WebSocketConstructor = new (url: string | URL) => WebSocket;

/** Resolve the HttpOnly server session immediately before opening its socket. */
export async function createWorkerManagedWebSocket(
  endpoint: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
  WebSocketImpl: WebSocketConstructor = WebSocket,
): Promise<WebSocket> {
  const socketUrl = new URL(endpoint);
  const healthUrl = new URL("/api/health", socketUrl);
  healthUrl.protocol = socketUrl.protocol === "wss:" ? "https:" : "http:";
  const healthResponse = await fetchImpl(healthUrl, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!healthResponse.ok) {
    throw new Error(`Could not check the agent session (HTTP ${healthResponse.status})`);
  }
  const health = await healthResponse.json().catch(() => undefined) as
    | { agent_configured?: boolean }
    | undefined;
  if (!health?.agent_configured) {
    throw new Error("Connect to start the agent");
  }

  socketUrl.searchParams.set("session_id", sessionId);
  return await waitForProxyHandshake(new WebSocketImpl(socketUrl));
}

function waitForProxyHandshake(socket: WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new Error("Agent connection timed out")), 20_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close();
      reject(error);
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        fail(new Error("Agent connection returned an invalid handshake"));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        fail(new Error("Agent connection returned an invalid handshake"));
        return;
      }
      if (!isRecord(message)) {
        fail(new Error("Agent connection returned an invalid handshake"));
        return;
      }
      if (message.type === "nanocodex.proxy.ready") {
        settled = true;
        cleanup();
        resolve(socket);
        return;
      }
      if (message.type === "nanocodex.proxy.rejected"
        && Number.isInteger(message.status)
        && Number(message.status) >= 100
        && Number(message.status) <= 599) {
        const status = Number(message.status);
        const body = typeof message.error === "string" ? message.error : `HTTP ${status}`;
        const retryAfter = Number(message.retryAfter);
        fail(Object.assign(new Error(`Agent connection rejected with HTTP ${status}: ${body}`), {
          status,
          body,
          ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfter } : {}),
        }));
        return;
      }
      fail(new Error("Agent connection returned an invalid handshake"));
    };
    const onError = () => fail(new Error("WebSocket connection failed"));
    const onClose = (event: CloseEvent) => fail(
      new Error(`WebSocket closed during connection with code ${event.code}`),
    );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
