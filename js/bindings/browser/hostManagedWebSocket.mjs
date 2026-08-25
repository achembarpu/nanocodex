const DEFAULT_TIMEOUT_MS = 10_000;
const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;

/** Open Nanocodex's same-origin Responses proxy and consume its setup frame. */
export function openHostManagedWebSocket(endpoint, sessionId, options = {}) {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new TypeError("host-managed WebSocket requires a session ID");
  }
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof WebSocketImpl !== "function") {
    throw new Error("WebSocket is unavailable in this runtime");
  }
  const socketUrl = resolveWebSocketUrl(endpoint);
  socketUrl.searchParams.set("session_id", sessionId);
  return waitForProxyHandshake(
    new WebSocketImpl(socketUrl),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

export function defaultHostManagedWebSocketUrl(location = globalThis.location) {
  if (!location?.href) {
    throw new Error("host-managed transport requires websocketUrl outside a browser location");
  }
  const url = new URL("/api/responses", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * Share one browser WebSocket across independent host-managed agent sockets.
 * Each returned socket retains normal WebSocket ownership and lifecycle while
 * the proxy opens a separate upstream Responses socket for every channel.
 */
export function createHostManagedWebSocketMultiplexer(options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof WebSocketImpl !== "function") {
    throw new Error("WebSocket is unavailable in this runtime");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("host-managed WebSocket timeout must be a positive integer");
  }
  const pools = new Map();
  let nextChannel = 1;

  return function createWebSocket(endpoint, sessionId) {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new TypeError("host-managed WebSocket requires a session ID");
    }
    const endpointUrl = resolveWebSocketUrl(endpoint);
    const muxUrl = new URL(endpointUrl);
    muxUrl.pathname = `${muxUrl.pathname.replace(/\/$/, "")}/mux`;
    muxUrl.search = "";
    const key = muxUrl.href;
    let pool = pools.get(key);
    if (!pool || pool.closed) {
      pool = createMuxPool(muxUrl, WebSocketImpl, () => pools.delete(key));
      pools.set(key, pool);
    }
    const channelId = `c${nextChannel++}`;
    return pool.open(channelId, sessionId, timeoutMs);
  };
}

function createMuxPool(url, WebSocketImpl, onClosed) {
  const physical = new WebSocketImpl(url);
  const channels = new Map();
  const pendingOpens = [];
  let closed = false;

  const send = (message) => {
    const encoded = JSON.stringify(message);
    if (physical.readyState === WEBSOCKET_OPEN) physical.send(encoded);
    else if (physical.readyState === WEBSOCKET_CONNECTING) pendingOpens.push(encoded);
    else throw new Error("multiplexed WebSocket is no longer open");
  };
  const releaseChannel = (channelId) => {
    channels.delete(channelId);
    if (channels.size !== 0 || closed) return;
    closed = true;
    pendingOpens.length = 0;
    onClosed();
    if (physical.readyState <= WEBSOCKET_OPEN) physical.close(1000, "multiplexer idle");
  };
  const failAll = (error, closeEvent) => {
    if (closed) return;
    closed = true;
    pendingOpens.length = 0;
    onClosed();
    for (const channel of channels.values()) {
      channel.fail(error, closeEvent);
    }
    channels.clear();
  };

  physical.addEventListener("open", () => {
    for (const message of pendingOpens.splice(0)) physical.send(message);
  });
  physical.addEventListener("message", (event) => {
    const message = parseHandshake(event.data);
    const channelId = message?.channel_id;
    if (typeof channelId !== "string") {
      failAll(new Error("Agent multiplexer returned an invalid message"));
      physical.close(1002, "invalid multiplexed message");
      return;
    }
    const channel = channels.get(channelId);
    if (!channel) return;
    if (message.type === "nanocodex.mux.ready") {
      channel.ready();
      return;
    }
    if (message.type === "nanocodex.mux.data" && typeof message.data === "string") {
      channel.message(message.data);
      return;
    }
    if (message.type === "nanocodex.mux.rejected"
      && Number.isInteger(message.status)
      && message.status >= 100
      && message.status <= 599) {
      const retryAfter = Number(message.retryAfter);
      channel.reject(Object.assign(
        new Error(`Agent connection rejected with HTTP ${message.status}: ${
          typeof message.error === "string" ? message.error : `HTTP ${message.status}`
        }`),
        {
          status: message.status,
          body: typeof message.error === "string" ? message.error : `HTTP ${message.status}`,
          ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfter } : {}),
        },
      ));
      releaseChannel(channelId);
      return;
    }
    if (message.type === "nanocodex.mux.closed") {
      channel.remoteClose(message.code, message.reason);
      releaseChannel(channelId);
      return;
    }
    channel.fail(new Error("Agent multiplexer returned an invalid channel message"));
    channels.delete(channelId);
  });
  physical.addEventListener("error", () => {
    for (const channel of channels.values()) channel.error();
  });
  physical.addEventListener("close", (event) => {
    failAll(
      new Error(`Multiplexed WebSocket closed with code ${event.code}`),
      event,
    );
  });

  return {
    get closed() { return closed; },
    open(channelId, sessionId, timeout) {
      if (closed) return Promise.reject(new Error("multiplexed WebSocket is closed"));
      let resolveOpen;
      let rejectOpen;
      const promise = new Promise((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      });
      const socket = createVirtualWebSocket({
        channelId,
        onClose(code, reason) {
          try {
            send({ type: "nanocodex.mux.close", channel_id: channelId, code, reason });
          } catch { /* The physical close already owns cleanup. */ }
          releaseChannel(channelId);
        },
        onSend(data) {
          send({ type: "nanocodex.mux.data", channel_id: channelId, data });
        },
      });
      const timer = setTimeout(() => {
        channel.reject(new Error("Agent connection timed out"));
        try {
          send({ type: "nanocodex.mux.close", channel_id: channelId, code: 1000, reason: "timeout" });
        } catch { /* The physical close already owns cleanup. */ }
        releaseChannel(channelId);
      }, timeout);
      const channel = {
        error: () => socket.dispatch("error", {}),
        fail(error, closeEvent) {
          clearTimeout(timer);
          socket.fail(error, closeEvent);
          rejectOpen(error);
        },
        message: (data) => socket.dispatch("message", { data }),
        ready() {
          clearTimeout(timer);
          socket.open();
          resolveOpen(socket);
        },
        reject(error) {
          clearTimeout(timer);
          socket.reject(error);
          rejectOpen(error);
        },
        remoteClose(code, reason) {
          clearTimeout(timer);
          socket.remoteClose(code, reason);
          if (socket.readyState !== WEBSOCKET_OPEN) {
            rejectOpen(new Error(`WebSocket closed during connection with code ${code ?? 1000}`));
          }
        },
      };
      channels.set(channelId, channel);
      try {
        send({ type: "nanocodex.mux.open", channel_id: channelId, session_id: sessionId });
      } catch (error) {
        channels.delete(channelId);
        channel.reject(error);
      }
      return promise;
    },
  };
}

function createVirtualWebSocket({ channelId, onClose, onSend }) {
  const listeners = new Map();
  let readyState = WEBSOCKET_CONNECTING;
  const socket = {
    get bufferedAmount() { return 0; },
    get readyState() { return readyState; },
    addEventListener(type, listener, options) {
      const entries = listeners.get(type) ?? new Set();
      entries.add({ listener, once: options?.once === true });
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type);
      if (!entries) return;
      for (const entry of entries) {
        if (entry.listener === listener) entries.delete(entry);
      }
    },
    send(data) {
      if (readyState !== WEBSOCKET_OPEN) throw new Error("WebSocket is not open");
      if (typeof data !== "string") throw new TypeError("multiplexed WebSocket requires text frames");
      onSend(data);
    },
    close(code = 1000, reason = "") {
      if (readyState >= WEBSOCKET_CLOSING) return;
      readyState = WEBSOCKET_CLOSING;
      onClose(code, reason);
      readyState = WEBSOCKET_CLOSED;
      socket.dispatch("close", { code, reason, wasClean: true });
    },
    dispatch(type, event) {
      for (const entry of [...(listeners.get(type) ?? [])]) {
        if (entry.once) listeners.get(type)?.delete(entry);
        if (typeof entry.listener === "function") entry.listener.call(socket, event);
        else entry.listener?.handleEvent?.(event);
      }
    },
    open() {
      if (readyState !== WEBSOCKET_CONNECTING) return;
      readyState = WEBSOCKET_OPEN;
      socket.dispatch("open", {});
    },
    reject(error) {
      if (readyState >= WEBSOCKET_CLOSING) return;
      readyState = WEBSOCKET_CLOSED;
      socket.dispatch("error", { error });
      socket.dispatch("close", { code: 1011, reason: error.message, wasClean: false });
    },
    fail(error, closeEvent) {
      if (readyState >= WEBSOCKET_CLOSING) return;
      readyState = WEBSOCKET_CLOSED;
      socket.dispatch("error", { error });
      socket.dispatch("close", closeEvent ?? { code: 1011, reason: error.message, wasClean: false });
    },
    remoteClose(code = 1000, reason = "") {
      if (readyState >= WEBSOCKET_CLOSING) return;
      readyState = WEBSOCKET_CLOSED;
      socket.dispatch("close", { code, reason, wasClean: code === 1000 });
    },
    channelId,
  };
  return socket;
}

function resolveWebSocketUrl(endpoint) {
  const base = globalThis.location?.href;
  const url = base === undefined ? new URL(endpoint) : new URL(endpoint, base);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("host-managed websocketUrl must use ws: or wss:");
  }
  return url;
}

function waitForProxyHandshake(socket, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    socket.close();
    throw new TypeError("host-managed WebSocket timeout must be a positive integer");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => fail(new Error("Agent connection timed out")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close();
      reject(error);
    };
    const onMessage = (event) => {
      const message = parseHandshake(event.data);
      if (message?.type === "nanocodex.proxy.ready") {
        settled = true;
        cleanup();
        resolve(socket);
        return;
      }
      if (message?.type === "nanocodex.proxy.rejected"
        && Number.isInteger(message.status)
        && message.status >= 100
        && message.status <= 599) {
        const status = message.status;
        const body = typeof message.error === "string" ? message.error : `HTTP ${status}`;
        const retryAfter = Number(message.retryAfter);
        fail(Object.assign(
          new Error(`Agent connection rejected with HTTP ${status}: ${body}`),
          {
            status,
            body,
            ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfter } : {}),
          },
        ));
        return;
      }
      fail(new Error("Agent connection returned an invalid handshake"));
    };
    const onError = () => fail(new Error("WebSocket connection failed"));
    const onClose = (event) => fail(
      new Error(`WebSocket closed during connection with code ${event.code}`),
    );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function parseHandshake(data) {
  if (typeof data !== "string") return undefined;
  try {
    const value = JSON.parse(data);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
