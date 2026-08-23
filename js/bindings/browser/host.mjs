import { createCodeRuntime, toolResult } from "../runtime/code-runtime.mjs";
import { utf8ByteLength } from "../runtime/utf8.mjs";
import { createWorkerEvaluator } from "../runtime/worker-evaluator.mjs";
import { openHostManagedWebSocket } from "./hostManagedWebSocket.mjs";

const DEFAULT_MAX_QUEUED_MESSAGES = 4_096;
const DEFAULT_MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_SEND_BYTES = 16 * 1024 * 1024;
const MPP_CLIENT_PROTOCOL_ERROR_CLOSE_CODE = 3008;
const WEBSOCKET_OPEN = 1;

export function createBrowserHost(options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const createWebSocket = options.createWebSocket
    ?? (options.hostManagedProtocol && ((endpoint, sessionId) =>
      openHostManagedWebSocket(endpoint, sessionId, { WebSocketImpl })))
    ?? (WebSocketImpl && ((endpoint) => new WebSocketImpl(endpoint)));
  if (!options.mpp && !createWebSocket) {
    throw new Error("WebSocket is unavailable in this runtime");
  }
  const connections = new Map();
  const codeEvaluator = options.codeEvaluator
    ?? (typeof globalThis.Worker === "function"
      ? createWorkerEvaluator()
      : () => Promise.reject(new Error(
          "browser Code Mode requires a child Worker or an explicit codeEvaluator",
        )));
  const code = createCodeRuntime(options.tools, { evaluate: codeEvaluator });
  if (options.filesystem && options.filesystemTools === false) {
    code.addTools({
      apply_patch: {
        description: "Apply a Rust-verified patch to the browser workspace.",
        parameters: { type: "object", additionalProperties: false },
        async handler(input, context) {
          if (typeof options.applyPatch !== "function") {
            throw new Error("the Rust browser apply_patch planner is unavailable");
          }
          const summary = await options.applyPatch(input, context.sessionId);
          return toolResult(summary, {});
        },
      },
    });
  }
  const filesystemReady = options.filesystem && options.filesystemTools !== false
    ? import("../runtime/workspace.mjs")
        .then(({ tools }) => code.addTools(tools(options.filesystem)))
    : undefined;
  const toolMode = options.toolMode ?? "code";
  if (toolMode !== "code" && toolMode !== "direct") {
    throw new TypeError("toolMode must be code or direct");
  }
  if (options.mcp && toolMode !== "code") {
    throw new TypeError("remote MCP requires Code Mode");
  }
  const mcp = options.mcp
    ? import("../runtime/mcp-runtime.mjs").then(({ createMcpRuntime }) =>
        createMcpRuntime(options.mcp, { clientName: "nanocodex-browser" }))
    : undefined;
  if (mcp) mcp.then((provider) => code.addProvider(provider), () => {});
  const mcpReady = mcp?.then((provider) => provider.settled());
  const onEvent = options.onEvent || (() => {});
  const maxQueuedMessages = options.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES;
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const maxBufferedSendBytes = options.maxBufferedSendBytes ?? DEFAULT_MAX_BUFFERED_SEND_BYTES;
  let nextHandle = 1;
  let references = 0;
  let disposal;
  let preconnected;

  function preconnect(endpoint, sessionId) {
    if (disposal) return Promise.reject(new Error("Nanocodex host is already disposed"));
    if (preconnected?.endpoint === endpoint && preconnected.sessionId === sessionId) {
      return preconnected.promise.then(() => undefined);
    }
    closePreconnected();
    const promise = Promise.resolve().then(() => createWebSocket(endpoint, sessionId, {
      authorization: "preconnect",
    }));
    const entry = { endpoint, sessionId, promise };
    preconnected = entry;
    void promise.catch(() => {
      if (preconnected === entry) preconnected = undefined;
    });
    return promise.then(() => undefined);
  }

  function takePreconnected(endpoint, sessionId) {
    if (preconnected?.endpoint !== endpoint || preconnected.sessionId !== sessionId) {
      return undefined;
    }
    const promise = preconnected.promise;
    preconnected = undefined;
    return promise;
  }

  function closePreconnected() {
    const entry = preconnected;
    preconnected = undefined;
    void entry?.promise.then((opened) => normalizeWebSocketConnection(opened).socket.close()).catch(() => {});
  }

  async function connect(endpoint, apiKey, sessionId, metadata = {}) {
    if (disposal) throw new Error("Nanocodex host is already disposed");
    if (options.mpp) return connectMpp(endpoint);
    const authorization = options.hostAuth
      ? { authorization: "host_managed" }
      : { authorization: "bearer", bearerToken: apiKey };
    const request = { ...metadata };
    delete request.authorization;
    delete request.bearerToken;
    Object.assign(request, authorization);
    const opened = await (takePreconnected(endpoint, sessionId)
      ?? createWebSocket(endpoint, sessionId, request));
    const { socket, ...handshake } = normalizeWebSocketConnection(opened);
    if (disposal) {
      socket.close();
      throw new Error("Nanocodex host was disposed during WebSocket connection");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const connection = {
        socket,
        queue: [],
        queuedBytes: 0,
        waiter: undefined,
        intentionallyClosed: false,
        overflowed: false,
      };
      const resolveOpen = () => {
        if (settled) return;
        settled = true;
        const handle = nextHandle++;
        connections.set(handle, connection);
        resolve(JSON.stringify({
          handle,
          status: handshake.status ?? 101,
          request_id: handshake.requestId,
          server_model: handshake.serverModel,
          reasoning_included: handshake.reasoningIncluded ?? false,
          turn_state: handshake.turnState,
        }));
      };
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener("message", (event) => {
        enqueue(connection, typeof event.data === "string"
          ? { kind: "text", text: event.data }
          : { kind: "binary" });
      });
      socket.addEventListener("close", (event) => {
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed during connection with code ${event.code}`));
        } else if (!connection.intentionallyClosed && !connection.overflowed) {
          enqueue(connection, { kind: "closed", detail: `with code ${event.code}` });
        }
      });
      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket connection failed"));
        } else {
          enqueue(connection, { kind: "error", detail: "WebSocket connection failed" });
        }
      });
      if (socket.readyState === WEBSOCKET_OPEN) resolveOpen();
      else if (socket.readyState > WEBSOCKET_OPEN) {
        settled = true;
        reject(new Error("WebSocket closed during connection"));
      }
    });
  }

  async function connectMpp(endpoint) {
    if (disposal) throw new Error("Nanocodex host is already disposed");
    if (typeof options.mpp.ws !== "function") {
      throw new TypeError("mpp must provide ws(endpoint)");
    }
    const socket = await options.mpp.ws(endpoint);
    if (!socket || typeof socket.addEventListener !== "function") {
      throw new TypeError("mpp.ws(endpoint) must return a WebSocket");
    }
    if (disposal) {
      socket.close();
      throw new Error("Nanocodex host was disposed during WebSocket connection");
    }
    const handle = nextHandle++;
    const connection = {
      socket,
      queue: [],
      queuedBytes: 0,
      waiter: undefined,
      intentionallyClosed: false,
      overflowed: false,
      managed: true,
    };
    connections.set(handle, connection);
    socket.addEventListener("message", (event) => {
      enqueue(connection, typeof event.data === "string"
        ? { kind: "text", text: event.data }
        : { kind: "binary" });
    });
    socket.addEventListener("close", (event) => {
      if (!connection.intentionallyClosed && !connection.overflowed) {
        const code = event.code ?? 1000;
        const suffix = event.reason ? `: ${event.reason}` : "";
        enqueue(connection, code === MPP_CLIENT_PROTOCOL_ERROR_CLOSE_CODE
          ? {
              kind: "error",
              detail: `MPP WebSocket payment flow failed with code ${code}${suffix}`,
              reconnectable: false,
            }
          : { kind: "closed", detail: `with code ${code}${suffix}` });
      }
    });
    socket.addEventListener("error", () => {
      enqueue(connection, { kind: "error", detail: "MPP WebSocket connection failed" });
    });
    return JSON.stringify({ handle, status: 101, reasoning_included: false });
  }

  function send(handle, message) {
    const connection = connections.get(handle);
    if (!connection || connection.socket.readyState !== WEBSOCKET_OPEN) {
      return Promise.resolve(JSON.stringify({
        ok: false,
        reconnectable: true,
        error: "WebSocket is no longer open",
      }));
    }
    try {
      if (connection.managed) {
        connection.socket.send(JSON.stringify({ mpp: "message", data: message }));
        return Promise.resolve(JSON.stringify({ ok: true }));
      }
      const frameBytes = utf8ByteLength(message);
      if (frameBytes > maxBufferedSendBytes
        || connection.socket.bufferedAmount + frameBytes > maxBufferedSendBytes) {
        return Promise.resolve(JSON.stringify({
          ok: false,
          reconnectable: false,
          error: `buffered WebSocket sends exceeded ${maxBufferedSendBytes} bytes`,
        }));
      }
      connection.socket.send(message);
      return Promise.resolve(JSON.stringify({ ok: true }));
    } catch (error) {
      return Promise.resolve(JSON.stringify({
        ok: false,
        reconnectable: connection.socket.readyState !== WEBSOCKET_OPEN,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  function next(handle, timeoutMs) {
    const connection = connections.get(handle);
    if (!connection) {
      return Promise.resolve(JSON.stringify({ kind: "closed", detail: "before the next frame" }));
    }
    if (connection.queue.length) {
      const entry = connection.queue.shift();
      connection.queuedBytes -= entry.bytes;
      return Promise.resolve(JSON.stringify(entry.message));
    }
    if (connection.waiter) return Promise.reject(new Error("concurrent reads are unsupported"));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        connection.waiter = undefined;
        resolve(JSON.stringify({ kind: "timeout" }));
      }, timeoutMs);
      connection.waiter = (message) => {
        clearTimeout(timer);
        connection.waiter = undefined;
        resolve(JSON.stringify(message));
      };
    });
  }

  function close(handle) {
    const connection = connections.get(handle);
    if (!connection) return;
    connections.delete(handle);
    connection.intentionallyClosed = true;
    connection.waiter?.({ kind: "closed", detail: "by the WASM runtime" });
    connection.socket.close();
  }

  function enqueue(connection, message) {
    if (connection.overflowed) return;
    if (connection.waiter) {
      connection.waiter(message);
      return;
    }
    const bytes = utf8ByteLength(message.kind === "text" ? message.text : JSON.stringify(message));
    if (connection.queue.length >= maxQueuedMessages || connection.queuedBytes + bytes > maxQueuedBytes) {
      connection.queue.length = 0;
      connection.queuedBytes = 0;
      connection.overflowed = true;
      const error = {
        kind: "error",
        detail: `receive queue exceeded ${maxQueuedMessages} messages or ${maxQueuedBytes} bytes`,
      };
      const errorBytes = utf8ByteLength(JSON.stringify(error));
      connection.queue.push({ message: error, bytes: errorBytes });
      connection.queuedBytes = errorBytes;
      connection.socket.close(1009, "receive queue exceeded configured bounds");
      return;
    }
    connection.queue.push({ message, bytes });
    connection.queuedBytes += bytes;
  }

  async function dispose() {
    if (disposal) return disposal;
    disposal = (async () => {
      for (const handle of [...connections.keys()]) close(handle);
      closePreconnected();
      code.reset();
      await mcp?.then((provider) => provider.close(), () => {});
      options.onDispose?.();
    })();
    return disposal;
  }

  return Object.freeze({
    ready: async () => { await Promise.all([filesystemReady, mcpReady]); },
    retain() {
      if (disposal) throw new Error("Nanocodex host is already disposed");
      references += 1;
    },
    release() {
      if (references > 0) references -= 1;
      return references === 0 ? dispose() : Promise.resolve();
    },
    connect,
    preconnect,
    send,
    next,
    close,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    executeCode: code.executeCodeObserved,
    nextCodeUpdate: code.nextCodeUpdate,
    executeTool: code.executeTool,
    cancelCode: code.cancel,
    readWorkspaceFile: async (path) => {
      if (!options.filesystem) throw new Error("browser workspace is unavailable");
      const contents = await options.filesystem.readFile(path);
      if (!(contents instanceof Uint8Array)) {
        throw new TypeError("browser workspace readFile() must return Uint8Array");
      }
      return contents;
    },
    writeWorkspaceFile: async (path, contents) => {
      if (!options.filesystem) throw new Error("browser workspace is unavailable");
      await options.filesystem.writeFile(path, contents);
    },
    removeWorkspaceFile: async (path) => {
      if (!options.filesystem) throw new Error("browser workspace is unavailable");
      await options.filesystem.remove(path);
    },
    toolMode: () => toolMode,
    toolDefinitions: code.toolDefinitions,
    releaseSession: code.releaseSession,
    emitEvent: onEvent,
    reset: code.reset,
    dispose,
  });
}

function normalizeWebSocketConnection(opened) {
  if (opened?.socket && typeof opened.socket.addEventListener === "function") {
    return opened;
  }
  if (!opened || typeof opened.addEventListener !== "function") {
    throw new TypeError("createWebSocket must return a WebSocket or a connection descriptor");
  }
  return { socket: opened };
}
