type WebSocketConstructor = new (url: string | URL) => WebSocket;

/** Resolve the HttpOnly server session immediately before opening its socket. */
export async function createWorkerManagedWebSocket(
  endpoint: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
  WebSocketImpl: WebSocketConstructor = WebSocket,
): Promise<WebSocket> {
  const socketUrl = new URL(endpoint);
  const health = await (
    await fetchImpl(new URL("/api/health", endpoint.replace("ws", "http")))
  ).json() as { agent_configured?: boolean };
  if (!health.agent_configured) {
    throw new Error("Sign in with ChatGPT to start the agent");
  }

  socketUrl.searchParams.set("session_id", sessionId);
  return new WebSocketImpl(socketUrl);
}
