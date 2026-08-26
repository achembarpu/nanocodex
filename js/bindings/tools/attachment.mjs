import { toolRouterRuntime } from "../runtime/tool-router.mjs";
import { utf8ByteLength } from "../runtime/utf8.mjs";

const PROTOCOL_VERSION = 1;
const CAPABILITY = "tools";
const CAPABILITY_VERSION = 1;
const CATALOG_DIGEST_DOMAIN = "nanocodex-hosted-tools-catalog-v1\0";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const OPEN = 1;
const TOOL_RESULT = Symbol.for("nanocodex.toolResult");

const base = Object.freeze({ protocol_version: PROTOCOL_VERSION, capability: CAPABILITY });

/** Creates the client side of the canonical reverse tool attachment protocol v1. */
export function createAttachment(owner, target, options = {}) {
  const router = owner?.[toolRouterRuntime];
  if (!router || typeof router.execute !== "function") {
    throw new TypeError("attach requires a Tools runtime");
  }
  validateAttachmentOptions(target, options);
  const endpoint = attachmentEndpoint(target);
  const transport = attachmentTransport(target);
  const hostId = uuidV7();
  let client;
  let starting;
  let stopped = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  return Object.freeze({
    async connect() {
      if (stopped) throw new Error("tool attachment connector is closed");
      if (!starting) starting = (async () => {
        await router.settled?.();
        if (stopped) throw new Error("tool attachment connector is closed");
        const admission = router.snapshot();
        if (stopped) {
          admission.release();
          throw new Error("tool attachment connector is closed");
        }
        const created = createClient(endpoint, transport, options, admission, hostId);
        void created.public.closed().then(resolveClosed);
        return created;
      })();
      client = await starting;
      await client.ready;
      return client.public;
    },
    close() {
      stopped = true;
      if (client) return client.public.close();
      if (!starting) {
        resolveClosed();
        return closed;
      }
      void starting.then(
        (created) => created.public.close(),
        () => resolveClosed(),
      );
      return closed;
    },
    closed() { return closed; },
  });
}

function createClient(endpoint, transport, options, admission, hostId) {
  const state = {
    socket: undefined,
    lease: undefined,
    catalogRevision: 1,
    catalog: hostedCatalog(admission.catalog(options.provider ?? "javascript")),
    calls: new Map(),
    receipts: new Map(),
    history: new Map(),
    heartbeat: undefined,
    handshakeTimer: undefined,
    leaseWatchdog: undefined,
    reconnectTimer: undefined,
    stopped: false,
    connected: false,
    readySettled: false,
    admissionReleased: false,
  };
  const catalogDigestPromise = catalogDigest(state.catalog);
  let resolveReady;
  let rejectReady;
  let resolveClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const publicClient = Object.freeze({
    get connected() { return state.connected; },
    closed() { return closed; },
    close(code = 1000, reason = "tool attachment detached") {
      if (state.stopped) {
        resolveClosed();
        return closed;
      }
      state.stopped = true;
      if (!state.readySettled) {
        state.readySettled = true;
        rejectReady(new Error(reason));
      }
      clearTimers(state);
      abortGeneration(state, new Error(reason));
      releaseAdmission();
      state.connected = false;
      if (state.socket) {
        const socket = state.socket;
        closeSocket(socket, closeCode(code), closeReason(String(reason)));
      } else resolveClosed();
      return closed;
    },
  });
  const client = { ready, public: publicClient };
  void connectGeneration();
  return client;

  async function connectGeneration() {
    if (state.stopped) return;
    try {
      const socket = await openSocket(endpoint, transport);
      if (state.stopped) { socket.close(1000, "attachment stopped"); return; }
      state.socket = socket;
      state.lease = undefined;
      bindSocket(socket, {
        open() {
          if (state.socket !== socket) return;
          send(socket, {
            ...base,
            type: "attach",
            host_id: hostId,
            capabilities: [{ name: CAPABILITY, version: CAPABILITY_VERSION }],
          });
        },
        message(encoded) {
          if (state.socket !== socket) return;
          if (typeof encoded !== "string") {
            fenceLocal(socket, "tool attachments require text frames");
            return;
          }
          void handleManagedFrame(encoded, socket).catch((error) => fenceLocal(socket, errorMessage(error)));
        },
        close() { socketClosed(socket); },
        error(error) {
          if (state.socket !== socket) return;
          if (!state.readySettled) {
            state.readySettled = true;
            state.stopped = true;
            releaseAdmission();
            rejectReady(error);
            closeSocket(socket, 1011, "tool attachment initial connection failed");
          }
        },
      });
      state.handshakeTimer = setTimeout(() => {
        if (state.socket !== socket || state.connected) return;
        if (!state.readySettled) {
          state.readySettled = true;
          state.stopped = true;
          rejectReady(new Error("tool attachment handshake timed out before catalog acknowledgement"));
        }
        closeSocket(socket, 1012, "tool attachment handshake timed out");
      }, positiveOption(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, "handshakeTimeoutMs"));
      if (socket.readyState === OPEN) queueMicrotask(() => {
        if (state.socket === socket) send(socket, {
          ...base,
          type: "attach",
          host_id: hostId,
          capabilities: [{ name: CAPABILITY, version: CAPABILITY_VERSION }],
        });
      });
    } catch (error) {
      if (!state.stopped && state.readySettled && options.reconnect !== false) {
        state.reconnectTimer = setTimeout(connectGeneration, options.reconnectDelayMs ?? 250);
      } else if (!state.readySettled) {
        state.readySettled = true;
        releaseAdmission();
        rejectReady(error);
      }
      if (state.stopped || options.reconnect === false) resolveClosed();
    }
  }

  async function handleManagedFrame(encoded, socket) {
    if (state.socket !== socket) return;
    let frame;
    try { frame = parseFrame(encoded); }
    catch (error) { fenceLocal(socket, errorMessage(error)); return; }
    if (frame.type === "lease") {
      if (state.lease) { fenceLocal(socket, "duplicate lease"); return; }
      if (!hasToolsCapability(frame.capabilities)) { fenceLocal(socket, "lease omitted tools capability v1"); return; }
      state.lease = {
        leaseId: requiredString(frame.lease_id, "lease_id"),
        generation: positiveInteger(frame.generation, "generation"),
        expiresAt: positiveInteger(frame.expires_at, "expires_at"),
      };
      const digest = await catalogDigestPromise;
      if (state.socket !== socket || !state.lease) return;
      state.catalogDigest = digest;
      publishCatalog(socket);
      startHeartbeat(socket);
      return;
    }
    const lease = requirePinnedLease(frame, socket);
    if (!lease) return;
    switch (frame.type) {
      case "catalog_ack": {
        if (frame.catalog_revision !== state.catalogRevision || frame.catalog_digest !== state.catalogDigest) {
          fenceLocal(socket, "catalog acknowledgement did not match the published snapshot");
          return;
        }
        state.connected = true;
        clearTimeout(state.handshakeTimer);
        state.handshakeTimer = undefined;
        if (!state.readySettled) { state.readySettled = true; resolveReady(publicClient); }
        break;
      }
      case "call":
        await handleCall(frame, socket, lease);
        break;
      case "cancel":
        handleCancel(frame, socket, lease);
        break;
      case "result_ack":
        if (frame.catalog_revision !== state.catalogRevision) {
          fenceLocal(socket, "result acknowledgement did not match the pinned catalog");
          break;
        }
        const acknowledged = state.receipts.get(frame.call_id);
        if (!acknowledged) {
          fenceLocal(socket, "result acknowledgement did not match a retained terminal result");
        } else {
          state.receipts.delete(frame.call_id);
          state.history.set(frame.call_id, acknowledged);
          while (state.history.size > 512) state.history.delete(state.history.keys().next().value);
        }
        break;
      case "pong":
        lease.expiresAt = positiveInteger(frame.expires_at, "expires_at");
        break;
      case "fenced":
        // Fencing is authoritative. Reconnecting this host would immediately
        // steal the singleton lease back from the newer owner.
        state.stopped = true;
        clearTimers(state);
        abortGeneration(state, new Error(`tool attachment fenced: ${frame.reason}`));
        releaseAdmission();
        socket.close(1008, "tool attachment fenced");
        break;
      default:
        fenceLocal(socket, `unsupported managed frame: ${frame.type}`);
    }
  }

  function publishCatalog(socket) {
    const lease = state.lease;
    send(socket, {
      ...base,
      type: "catalog_publish",
      lease_id: lease.leaseId,
      generation: lease.generation,
      catalog_revision: state.catalogRevision,
      catalog_digest: state.catalogDigest,
      tools: state.catalog,
    });
  }

  async function handleCall(frame, socket, lease) {
    if (frame.host_id !== hostId || frame.catalog_revision !== state.catalogRevision) {
      fenceLocal(socket, "call did not match the pinned host catalog");
      return;
    }
    const callId = requiredString(frame.call_id, "call_id");
    const immutableIdentity = callIdentity(frame);
    const receipt = state.receipts.get(callId);
    if (receipt) {
      if (receipt.identity !== immutableIdentity) { fenceLocal(socket, "completed call ID was reused with different immutable fields"); return; }
      send(socket, receipt.frame);
      return;
    }
    const completed = state.history.get(callId);
    if (completed) {
      if (completed.identity !== immutableIdentity) { fenceLocal(socket, "completed call ID was reused with different immutable fields"); return; }
      send(socket, completed.frame);
      return;
    }
    const active = state.calls.get(callId);
    if (active) {
      if (active.identity !== immutableIdentity) fenceLocal(socket, "active call ID was reused with different immutable fields");
      return;
    }
    if (state.calls.size >= 64) {
      retainAndSend({ status: "unavailable", message: "tool attachment has 64 active calls" });
      return;
    }
    if (state.receipts.size >= 512) {
      fenceLocal(socket, "tool attachment retained receipt bound is exhausted");
      return;
    }
    const controller = new AbortController();
    const call = { controller, identity: immutableIdentity };
    state.calls.set(callId, call);
    if (frame.deadline_at <= Date.now()) {
      state.calls.delete(callId);
      retainAndSend({ status: "unavailable", message: "tool attachment call deadline elapsed before dispatch" });
      return;
    }
    let deadline;
    const deadlinePromise = new Promise((resolve) => {
      const arm = () => {
        const remaining = Number(frame.deadline_at) - Date.now();
        if (remaining <= 0) {
          controller.abort(new Error("tool attachment call deadline elapsed"));
          resolve({ deadline: true });
          return;
        }
        deadline = setTimeout(arm, Math.min(remaining, 2_147_483_647));
      };
      arm();
    });
    let outcome;
    let value;
    try {
      value = await Promise.race([
        admission.invoke(frame.name, frame.input, {
          sessionId: frame.session_id,
          parentCallId: "",
          callId,
          model: frame.model,
          signal: controller.signal,
        }),
        deadlinePromise,
      ]);
      if (value?.deadline) {
        outcome = { status: "ambiguous", message: "tool attachment call crossed its admitted deadline after dispatch" };
      }
    } catch (error) {
      outcome = controller.signal.aborted
        ? { status: "ambiguous", message: "tool attachment call ended after local deadline or transport cancellation" }
        : { status: "completed", output: failedOutput(error) };
    }
    if (!outcome) {
      try {
        const output = wireOutput(value);
        outcome = utf8ByteLength(JSON.stringify(output)) > positiveInteger(frame.output_byte_budget, "output_byte_budget")
          ? { status: "ambiguous", message: "tool attachment output exceeded the admitted byte budget after dispatch" }
          : { status: "completed", output };
      } catch {
        outcome = { status: "ambiguous", message: "tool attachment result was not valid bounded wire output after dispatch" };
      }
    }
    clearTimeout(deadline);
    state.calls.delete(callId);
    if (!outcome || state.socket !== socket || state.lease !== lease) return;
    retainAndSend(outcome);

    function retainAndSend(terminal) {
      const result = {
      ...base,
      type: "result",
      lease_id: lease.leaseId,
      generation: lease.generation,
      catalog_revision: state.catalogRevision,
      call_id: callId,
        outcome: terminal,
      };
      state.receipts.set(callId, { identity: immutableIdentity, frame: result });
      send(socket, result);
    }
  }

  function handleCancel(frame, socket, lease) {
    if (frame.catalog_revision !== state.catalogRevision) {
      fenceLocal(socket, "cancel did not match the pinned catalog");
      return;
    }
    const call = state.calls.get(frame.call_id);
    send(socket, {
      ...base,
      type: "cancel_ack",
      lease_id: lease.leaseId,
      generation: lease.generation,
      catalog_revision: state.catalogRevision,
      call_id: frame.call_id,
      // Once dispatched into a JS handler, AbortSignal cannot prove absence of
      // side effects. The terminal result remains authoritative.
      outcome: "too_late",
    });
  }

  function startHeartbeat(socket) {
    clearInterval(state.heartbeat);
    state.heartbeat = setInterval(() => {
      if (state.socket !== socket || !state.lease) return;
      send(socket, {
        ...base,
        type: "ping",
        lease_id: state.lease.leaseId,
        generation: state.lease.generation,
      });
    }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    state.leaseWatchdog = setInterval(() => {
      if (state.socket !== socket || !state.lease) return;
      if (Date.now() >= state.lease.expiresAt) closeSocket(socket, 1012, "tool attachment lease expired");
    }, Math.min(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, 1_000));
  }

  function requirePinnedLease(frame, socket) {
    const lease = state.lease;
    if (!lease || frame.lease_id !== lease.leaseId || frame.generation !== lease.generation) {
      fenceLocal(socket, "managed frame did not match the active lease generation");
      return undefined;
    }
    return lease;
  }

  function fenceLocal(socket, reason) {
    if (state.socket !== socket) return;
    state.stopped = true;
    clearTimers(state);
    abortGeneration(state, new Error(reason));
    releaseAdmission();
    state.connected = false;
    closeSocket(socket, 1008, closeReason(reason));
  }

  function closeSocket(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {
      socketClosed(socket);
      return;
    }
    // Cloudflare accepted sockets do not deliver a close callback to the
    // endpoint initiating closure, so the initiator owns local settlement.
    if (isCloudflareSocket(socket)) socketClosed(socket);
  }

  function socketClosed(socket) {
    if (state.socket !== socket) return;
    state.connected = false;
    state.socket = undefined;
    clearTimers(state);
    abortGeneration(state, new Error("tool attachment disconnected"));
    if (!state.stopped && state.readySettled && options.reconnect !== false) {
      state.reconnectTimer = setTimeout(connectGeneration, options.reconnectDelayMs ?? 250);
    } else if (!state.readySettled) {
      state.readySettled = true;
      releaseAdmission();
      rejectReady(new Error("tool attachment closed before catalog acknowledgement"));
    } else {
      releaseAdmission();
    }
    if (state.stopped || options.reconnect === false) resolveClosed();
  }

  function releaseAdmission() {
    if (state.admissionReleased) return;
    state.admissionReleased = true;
    admission.release();
  }
}

function closeCode(value) {
  return value === 1000 || (Number.isInteger(value) && value >= 3000 && value <= 4999)
    ? value
    : 1000;
}

function hostedCatalog(catalog) {
  if (catalog.length > 256) throw new RangeError("tool attachment catalogs contain at most 256 tools");
  return catalog.map((entry) => Object.freeze({
    provider: entry.provider,
    remote_name: entry.remote_name,
    definition: hostedDefinition(entry.definition),
    parallel_safe: entry.parallel_safe === true,
    ...(entry.summary === undefined ? {} : { summary: entry.summary }),
    timeout_ms: entry.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  }));
}

function hostedDefinition(definition) {
  if (definition.type === "custom") return Object.freeze({
    type: "custom",
    name: definition.name,
    description: definition.description,
    format: definition.format,
  });
  return Object.freeze({
    type: "function",
    name: definition.name,
    description: definition.description ?? "Application-defined tool.",
    strict: definition.strict ?? false,
    parameters: definition.parameters ?? { type: "object", additionalProperties: true },
    ...(definition.output_schema === undefined ? {} : { output_schema: definition.output_schema }),
  });
}

function wireOutput(value) {
  if (value?.[TOOL_RESULT]) return {
    output: outputBody(value.output),
    success: value.success,
    structured_result: snapshot(value.structuredResult),
    metadata: value.metadata == null ? null : snapshot(value.metadata),
    process_trace: null,
  };
  return {
    output: outputBody(value),
    success: true,
    structured_result: snapshot(value),
    metadata: null,
    process_trace: null,
  };
}

function failedOutput(error) {
  return { output: errorMessage(error), success: false, structured_result: null, metadata: null, process_trace: null };
}

function outputBody(value) {
  if (Array.isArray(value) && value.every((item) => ["input_text", "input_image", "input_audio"].includes(item?.type))) return snapshot(value);
  if (typeof value === "string") return value;
  return value === undefined ? "undefined" : JSON.stringify(value);
}

async function catalogDigest(catalog) {
  const input = new TextEncoder().encode(`${CATALOG_DIGEST_DOMAIN}${canonicalJson(catalog)}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareUnicodeScalars(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("catalog contains a non-JSON value");
  return encoded;
}
function compareUnicodeScalars(left, right) {
  const a = [...left]; const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (difference) return difference;
  }
  return a.length - b.length;
}

async function openSocket(endpoint, transport) {
  let socket;
  if (transport !== undefined) socket = await transport.connect(endpoint);
  else {
    if (typeof globalThis.window === "object" && !isSameOriginWebSocket(endpoint)) {
      throw new Error("browser tool attachments require a same-origin URL or an injected authenticated transport");
    }
    const WebSocketImpl = globalThis.WebSocket;
    if (typeof WebSocketImpl !== "function") throw new Error("WebSocket is unavailable; inject transport.connect() in this runtime");
    socket = new WebSocketImpl(endpoint);
  }
  if (!socket || typeof socket.send !== "function" || typeof socket.close !== "function") {
    throw new TypeError("attachment transport must return a WebSocket-compatible object");
  }
  return socket;
}

function validateAttachmentOptions(target, options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("tool attachment options must be an object");
  }
  const allowed = new Set([
    "provider", "reconnect", "reconnectDelayMs", "heartbeatMs",
    "handshakeTimeoutMs",
  ]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new TypeError(`unsupported tool attachment option: ${name}`);
  }
  if (options.provider !== undefined
      && (typeof options.provider !== "string" || !options.provider.trim())) {
    throw new TypeError("tool attachment provider must be a non-empty string");
  }
  if (options.reconnect !== undefined && typeof options.reconnect !== "boolean") {
    throw new TypeError("tool attachment reconnect must be boolean");
  }
  for (const name of ["reconnectDelayMs", "heartbeatMs", "handshakeTimeoutMs"]) {
    if (options[name] !== undefined) positiveInteger(options[name], name);
  }
  if (typeof target === "object" && !(target instanceof URL)) {
    if (!target || Array.isArray(target)) throw new TypeError("invalid tool attachment target");
    for (const name of Object.keys(target)) {
      if (!new Set(["endpoint", "transport"]).has(name)) {
        throw new TypeError(`unsupported tool attachment target field: ${name}`);
      }
    }
    if (target.endpoint === undefined) throw new TypeError("tool attachment target requires endpoint");
    if (!target.transport || typeof target.transport.connect !== "function") {
      throw new TypeError("tool attachment target transport must implement connect(endpoint)");
    }
  }
}

function isSameOriginWebSocket(endpoint) {
  if (!globalThis.location?.href) return false;
  const websocket = new URL(endpoint);
  const page = new URL(globalThis.location.href);
  const pageProtocol = page.protocol === "https:" ? "wss:" : page.protocol === "http:" ? "ws:" : "";
  return websocket.protocol === pageProtocol && websocket.host === page.host;
}

function isCloudflareSocket(socket) {
  return typeof socket.accept === "function";
}

function bindSocket(socket, handlers) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener("open", handlers.open);
    socket.addEventListener("message", (event) => handlers.message(event?.data));
    socket.addEventListener("close", handlers.close);
    socket.addEventListener("error", (event) => handlers.error(event?.error ?? new Error("tool attachment WebSocket failed")));
    return;
  }
  if (typeof socket.on === "function") {
    socket.on("open", handlers.open);
    socket.on("message", (data, isBinary) => handlers.message(
      isBinary === true ? data : typeof data === "string" ? data : decode(data),
    ));
    socket.on("close", handlers.close);
    socket.on("error", (error) => handlers.error(error ?? new Error("tool attachment WebSocket failed")));
    return;
  }
  throw new TypeError("attachment WebSocket must support addEventListener() or on()");
}
function send(socket, frame) { socket.send(JSON.stringify(frame)); }
function parseFrame(encoded) {
  if (typeof encoded !== "string") throw new TypeError("tool attachments require text frames");
  const text = encoded;
  if (utf8ByteLength(text) > 256 * 1024) throw new Error("tool attachment frame exceeds 262144 bytes");
  const frame = JSON.parse(text);
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new TypeError("tool attachment frame must be an object");
  if (frame.protocol_version !== PROTOCOL_VERSION || frame.capability !== CAPABILITY) throw new Error("unsupported tool attachment protocol");
  const keys = MANAGED_KEYS[frame.type];
  if (!keys) throw new Error(`unsupported managed tool attachment frame: ${frame.type}`);
  exactKeys(frame, keys);
  requiredString(frame.lease_id, "lease_id");
  positiveInteger(frame.generation, "generation");
  if (frame.type === "lease") {
    if (!UUID_V4.test(frame.lease_id)) throw new Error("lease_id must be a lowercase UUID v4");
    positiveInteger(frame.expires_at, "expires_at");
    if (!hasToolsCapability(frame.capabilities)) throw new Error("lease omitted tools capability v1");
  } else if (frame.type === "catalog_ack") {
    positiveInteger(frame.catalog_revision, "catalog_revision");
    if (typeof frame.catalog_digest !== "string" || !/^[0-9a-f]{64}$/.test(frame.catalog_digest)) throw new Error("invalid catalog_digest");
  } else if (frame.type === "call") {
    requiredString(frame.host_id, "host_id");
    positiveInteger(frame.catalog_revision, "catalog_revision");
    requiredIdentifier(frame.session_id, "session_id");
    requiredIdentifier(frame.call_id, "call_id");
    requiredIdentifier(frame.model, "model");
    requiredIdentifier(frame.name, "name");
    if (typeof frame.input !== "string" && (!frame.input || typeof frame.input !== "object" || Array.isArray(frame.input))) throw new Error("call input must be an object or string");
    if (utf8ByteLength(JSON.stringify(frame.input)) > 128 * 1024) throw new Error("call input exceeds 131072 bytes");
    positiveInteger(frame.output_token_budget, "output_token_budget");
    if (frame.output_token_budget > 1_000_000) throw new Error("output_token_budget exceeds protocol bound");
    if (positiveInteger(frame.output_byte_budget, "output_byte_budget") > 128 * 1024) throw new Error("output_byte_budget exceeds protocol bound");
    positiveInteger(frame.deadline_at, "deadline_at");
  } else if (frame.type === "cancel" || frame.type === "result_ack") {
    positiveInteger(frame.catalog_revision, "catalog_revision");
    requiredIdentifier(frame.call_id, "call_id");
  } else if (frame.type === "pong") {
    positiveInteger(frame.expires_at, "expires_at");
    if (frame.nonce !== undefined && (typeof frame.nonce !== "string" || utf8ByteLength(frame.nonce) > 128)) throw new Error("pong nonce exceeds protocol bound");
  } else if (frame.type === "fenced") {
    const reason = requiredString(frame.reason, "reason");
    if (utf8ByteLength(reason) > 2 * 1024) throw new Error("fenced reason exceeds protocol bound");
  }
  return frame;
}
function hasToolsCapability(value) {
  return Array.isArray(value)
    && value.length === 1
    && value[0]?.name === CAPABILITY
    && value[0].version === CAPABILITY_VERSION
    && Object.keys(value[0]).length === 2;
}
function clearTimers(state) {
  clearInterval(state.heartbeat);
  clearInterval(state.leaseWatchdog);
  clearTimeout(state.handshakeTimer);
  clearTimeout(state.reconnectTimer);
  state.heartbeat = undefined;
  state.leaseWatchdog = undefined;
  state.handshakeTimer = undefined;
  state.reconnectTimer = undefined;
}
function abortGeneration(state, reason) { for (const call of state.calls.values()) call.controller.abort(reason); state.calls.clear(); state.receipts.clear(); state.history.clear(); state.lease = undefined; }
function requiredString(value, name) { if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`); return value; }
function positiveInteger(value, name) { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`); return value; }
function positiveOption(value, fallback, name) { return value === undefined ? fallback : positiveInteger(value, name); }
function requiredIdentifier(value, name) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new TypeError(`${name} must be a safe ASCII identifier`); return value; }
function exactKeys(value, allowed) { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${value.type} contains unsupported field ${key}`); }
function snapshot(value) { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }
function decode(value) { if (value instanceof ArrayBuffer) return new TextDecoder().decode(value); if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value); return String(value); }
function errorMessage(error) { return error && (error.stack || error.message) || String(error); }
function callIdentity(frame) {
  return canonicalJson({
    host_id: frame.host_id,
    lease_id: frame.lease_id,
    generation: frame.generation,
    catalog_revision: frame.catalog_revision,
    session_id: frame.session_id,
    call_id: frame.call_id,
    model: frame.model,
    name: frame.name,
    input: frame.input,
    output_token_budget: frame.output_token_budget,
    output_byte_budget: frame.output_byte_budget,
    deadline_at: frame.deadline_at,
  });
}

function attachmentEndpoint(target) {
  const raw = typeof target === "object" && !(target instanceof URL) ? target.endpoint : target;
  let url;
  try { url = new URL(raw); }
  catch { throw new TypeError("tool attachment target must be a valid WebSocket URL"); }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("tool attachment target must use ws: or wss:");
  }
  if (url.username || url.password) throw new TypeError("tool attachment target must not contain credentials");
  if (url.hash) throw new TypeError("tool attachment target must not contain a fragment");
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) {
    throw new TypeError("plaintext ws: tool attachments are limited to loopback hosts");
  }
  return url.href;
}

function attachmentTransport(target) {
  return typeof target === "object" && !(target instanceof URL) ? target.transport : undefined;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
}

function closeReason(reason) {
  if (utf8ByteLength(reason) <= 123) return reason;
  let bounded = "";
  for (const scalar of reason) {
    if (utf8ByteLength(bounded + scalar) > 123) break;
    bounded += scalar;
  }
  return bounded;
}

function uuidV7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const milliseconds = BigInt(Date.now());
  for (let index = 5; index >= 0; index--) bytes[index] = Number((milliseconds >> BigInt((5 - index) * 8)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}


const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANAGED_KEYS = Object.freeze({
  lease: ["protocol_version", "capability", "type", "lease_id", "generation", "expires_at", "capabilities"],
  catalog_ack: ["protocol_version", "capability", "type", "lease_id", "generation", "catalog_revision", "catalog_digest"],
  call: ["protocol_version", "capability", "type", "host_id", "lease_id", "generation", "catalog_revision", "session_id", "call_id", "model", "name", "input", "output_token_budget", "output_byte_budget", "deadline_at"],
  cancel: ["protocol_version", "capability", "type", "lease_id", "generation", "catalog_revision", "call_id"],
  result_ack: ["protocol_version", "capability", "type", "lease_id", "generation", "catalog_revision", "call_id"],
  pong: ["protocol_version", "capability", "type", "lease_id", "generation", "expires_at", "nonce"],
  fenced: ["protocol_version", "capability", "type", "lease_id", "generation", "reason"],
});
