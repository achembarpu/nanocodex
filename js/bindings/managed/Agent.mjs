import { ManagedError } from "./ManagedError.mjs";

const API_KEY = /^ncx_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/;
const CURSOR = /^(?:0|[1-9][0-9]*)$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TERMINAL_TYPES = new Set([
  "turn_completed",
  "turn_cancelled",
  "turn_blocked",
  "turn_failed",
]);
const TERMINAL_CACHE_CAPACITY = 256;
const ALLOWED_OPTIONS = new Set(["apiKey", "baseUrl", "fetch"]);

/** Create a new managed agent owned by the authenticated account. */
export async function create(options = {}) {
  const client = managedClient(options);
  const receipt = await client.json("/v1/agents", { method: "POST" });
  return agentHandle(client, requiredString(receipt, "agent_id"));
}

/** List handles for every managed agent owned by the authenticated account. */
export async function list(options = {}) {
  const client = managedClient(options);
  const body = await client.json("/v1/agents");
  if (!body || !Array.isArray(body.data) || body.data.some((id) => typeof id !== "string")) {
    throw new ManagedError("invalid_response", "managed agent list is malformed");
  }
  return Object.freeze(body.data.map((id) => agentHandle(client, id)));
}

/** Resolve one owned managed agent and verify that it exists. */
export async function get(id, options = {}) {
  validateAgentId(id);
  const client = managedClient(options);
  await client.json(agentPath(id));
  return agentHandle(client, id);
}

/** Delete one owned managed agent and all of its retained state. */
export async function remove(id, options = {}) {
  validateAgentId(id);
  const client = managedClient(options);
  await client.empty(agentPath(id), { method: "DELETE" });
}

export { remove as delete };

function agentHandle(client, id) {
  validateAgentId(id);
  const eventStream = replayableEventStream(client, id);
  const events = Object.freeze({
    page: (options = {}) => eventHistoryPage(client, id, options),
    watch: (options = {}) => eventStream.subscribe(options),
  });
  const agent = {
    type: "managed",
    id,
    events,
    turn: Object.freeze({
      prompt: (options) => managedTurn(client, id, eventStream, options),
    }),
    state: () => client.json(agentPath(id)),
    delete: async () => {
      await client.empty(agentPath(id), { method: "DELETE" });
      eventStream.close();
    },
  };
  return Object.freeze(agent);
}

async function eventHistoryPage(client, agentId, options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("managed event history options must be an object");
  }
  const before = options.before;
  if (before !== undefined && (typeof before !== "string" || !CURSOR.test(before) || before === "0")) {
    throw new TypeError("managed event history cursor must be a positive decimal string");
  }
  const limit = options.limit ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new TypeError("managed event history limit must be an integer from 1 through 256");
  }
  const query = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) query.set("before", before);
  const body = await client.json(`${agentPath(agentId)}/events/history?${query}`);
  if (!body || !Array.isArray(body.data) || typeof body.has_more !== "boolean") {
    throw new ManagedError("invalid_response", "managed event history is malformed");
  }
  const latestCursor = requiredCursor(body, "latest_cursor");
  const data = body.data.map((event) => managedEvent(event));
  if (data.length > limit || data.some((event, index) =>
    (index > 0 && !cursorBefore(data[index - 1].cursor, event.cursor))
    || (before !== undefined && !cursorBefore(event.cursor, before)))) {
    throw new ManagedError("invalid_response", "managed event history ordering is malformed");
  }
  return Object.freeze({ data: Object.freeze(data), hasMore: body.has_more, latestCursor });
}

function managedTurn(client, agentId, eventStream, options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("managed prompt options must be an object");
  }
  const { id, input, signal } = options;
  if (id !== undefined && (typeof id !== "string" || !TURN_ID.test(id))) {
    throw new TypeError("managed turn id must be 1-128 safe ASCII characters");
  }
  const idempotencyKey = options.idempotencyKey ?? generatedIdempotencyKey();
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new TypeError("managed idempotency key must be 1-256 visible ASCII characters");
  }

  const submission = retrySubmission(client, agentId, {
    id,
    idempotencyKey,
    input,
    signal,
  });
  let result;
  const turn = {
    idempotencyKey,
    accepted: async () => requiredString(await submission, "turn_id"),
    state: async () => {
      const accepted = await submission;
      return client.json(turnPath(agentId, requiredString(accepted, "turn_id")), { signal });
    },
    steer: async ({ input }) => {
      const accepted = await submission;
      return client.json(`${turnPath(agentId, requiredString(accepted, "turn_id"))}/steer`, {
        method: "POST",
        body: JSON.stringify({ input }),
        signal,
      });
    },
    cancel: async () => {
      const accepted = await submission;
      return client.json(`${turnPath(agentId, requiredString(accepted, "turn_id"))}/cancel`, {
        method: "POST",
        signal,
      });
    },
    result: () => result ??= waitForResult(eventStream, submission, signal),
  };
  return Object.freeze(turn);
}

async function retrySubmission(client, agentId, options) {
  const body = JSON.stringify({
    ...(options.id === undefined ? {} : { id: options.id }),
    input: options.input,
  });
  let failure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.json(`${agentPath(agentId)}/turns`, {
        method: "POST",
        body,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted || error instanceof ManagedError) throw error;
      failure = error;
    }
  }
  throw failure;
}

async function waitForResult(eventStream, submission, signal) {
  const accepted = await submission;
  const turnId = requiredString(accepted, "turn_id");
  if (accepted.terminal) return terminalResult(turnId, accepted.terminal, accepted.terminal_cursor);
  const cursor = requiredCursor(accepted, "accepted_cursor");
  const events = eventStream.subscribe({ cursor, signal });
  try {
    const retained = eventStream.terminal(turnId, cursor);
    if (retained) return terminalResult(turnId, retained.data, retained.cursor);
    for await (const event of events) {
      const data = event.data;
      if (data.type === "stream_failed") {
        throw new ManagedError("stream_failed", stringOr(data.error, "managed event stream failed"));
      }
      if (data.turn_id !== turnId && data.id !== turnId) continue;
      if (TERMINAL_TYPES.has(data.type)) return terminalResult(turnId, data, event.cursor);
    }
  } finally {
    await events.return();
  }
  if (signal?.aborted) throw abortError(signal.reason);
  throw new ManagedError("event_stream_ended", "managed event stream ended before the turn completed");
}

function terminalResult(turnId, terminal, cursor) {
  if (!terminal || typeof terminal !== "object") {
    throw new ManagedError("invalid_response", "managed terminal turn is malformed");
  }
  if (terminal.type === "turn_completed") {
    if (typeof terminal.final_message !== "string") {
      throw new ManagedError("invalid_response", "managed completed turn has no final message");
    }
    return Object.freeze({
      turnId,
      finalMessage: terminal.final_message,
      usage: terminal.usage ?? null,
      ...(typeof terminal.usage_error === "string" ? { usageError: terminal.usage_error } : {}),
      ...(typeof cursor === "string" ? { cursor } : {}),
    });
  }
  const code = typeof terminal.type === "string" ? terminal.type : "turn_failed";
  const message = stringOr(terminal.error, `managed ${code.replaceAll("_", " ")}`);
  throw new ManagedError(code, message);
}

function replayableEventStream(client, agentId) {
  const subscribers = new Set();
  const terminals = new Map();
  let connection;
  let connectionCursor;
  let closed = false;

  const remove = (subscriber) => {
    if (!subscribers.delete(subscriber)) return;
    subscriber.signal?.removeEventListener("abort", subscriber.onAbort);
    if (subscribers.size === 0) connection?.controller.abort();
  };

  const finish = (subscriber, error) => {
    if (subscriber.done) return;
    subscriber.done = true;
    subscriber.error = error;
    if (subscriber.pending) {
      const pending = subscriber.pending;
      subscriber.pending = undefined;
      if (error) pending.reject(error);
      else pending.resolve({ value: undefined, done: true });
    }
  };

  const unsubscribe = (subscriber) => {
    finish(subscriber);
    remove(subscriber);
    return Promise.resolve({ value: undefined, done: true });
  };

  const start = () => {
    if (closed || connection || subscribers.size === 0) return;
    const cursor = [...subscribers].reduce(
      (lowest, subscriber) => cursorBefore(subscriber.cursor, lowest) ? subscriber.cursor : lowest,
      [...subscribers][0].cursor,
    );
    const controller = new AbortController();
    connectionCursor = cursor;
    const running = (async () => {
      try {
        for await (const event of readEvents(client, agentId, cursor, controller.signal)) {
          connectionCursor = event.cursor;
          const turnId = event.data.turn_id ?? event.data.id;
          if (typeof turnId === "string" && TERMINAL_TYPES.has(event.data.type)) {
            const retained = terminals.get(turnId);
            if (!retained || cursorBefore(retained.cursor, event.cursor)) {
              terminals.delete(turnId);
              terminals.set(turnId, event);
              if (terminals.size > TERMINAL_CACHE_CAPACITY) {
                terminals.delete(terminals.keys().next().value);
              }
            }
          }
          for (const subscriber of subscribers) {
            if (!cursorBefore(subscriber.cursor, event.cursor)) continue;
            subscriber.cursor = event.cursor;
            if (subscriber.pending) {
              const pending = subscriber.pending;
              subscriber.pending = undefined;
              pending.resolve({ value: event, done: false });
            } else {
              subscriber.queue.push(event);
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          for (const subscriber of subscribers) finish(subscriber, error);
          for (const subscriber of [...subscribers]) remove(subscriber);
        }
      }
    })();
    connection = { controller, running };
    running.finally(() => {
      if (connection?.running !== running) return;
      connection = undefined;
      connectionCursor = undefined;
      start();
    });
  };

  const subscribe = (options = {}) => {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("managed event options must be an object");
    }
    const cursor = options.cursor ?? "0";
    if (typeof cursor !== "string" || !CURSOR.test(cursor)) {
      throw new TypeError("managed event cursor must be an unsigned decimal string");
    }
    if (closed) throw new ManagedError("agent_closed", "managed agent event stream is closed");

    const subscriber = {
      cursor,
      queue: [],
      pending: undefined,
      done: false,
      error: undefined,
      signal: options.signal,
      onAbort: undefined,
    };
    const iterator = {
      next() {
        if (subscriber.queue.length > 0) {
          return Promise.resolve({ value: subscriber.queue.shift(), done: false });
        }
        if (subscriber.error) return Promise.reject(subscriber.error);
        if (subscriber.done) return Promise.resolve({ value: undefined, done: true });
        if (subscriber.pending) {
          return Promise.reject(new TypeError("managed event iterator already has a pending read"));
        }
        return new Promise((resolve, reject) => { subscriber.pending = { resolve, reject }; });
      },
      return: () => unsubscribe(subscriber),
      throw(error) {
        unsubscribe(subscriber);
        return Promise.reject(error);
      },
      [Symbol.asyncIterator]() { return this; },
    };
    if (subscriber.signal?.aborted) {
      subscriber.done = true;
      return Object.freeze(iterator);
    }
    subscriber.onAbort = () => unsubscribe(subscriber);
    subscriber.signal?.addEventListener("abort", subscriber.onAbort, { once: true });
    subscribers.add(subscriber);
    if (connectionCursor !== undefined && cursorBefore(cursor, connectionCursor)) {
      connection?.controller.abort();
    } else {
      start();
    }
    return Object.freeze(iterator);
  };

  return Object.freeze({
    subscribe,
    terminal(turnId, afterCursor) {
      const event = terminals.get(turnId);
      return event && cursorBefore(afterCursor, event.cursor) ? event : undefined;
    },
    close() {
      if (closed) return;
      closed = true;
      connection?.controller.abort();
      for (const subscriber of subscribers) finish(subscriber);
      for (const subscriber of [...subscribers]) remove(subscriber);
      terminals.clear();
    },
  });
}

async function* readEvents(client, agentId, initialCursor, signal) {
  let cursor = initialCursor;
  let reconnectDelay = 1_000;

  while (!signal?.aborted) {
    let response;
    try {
      response = await client.response(`${agentPath(agentId)}/events?cursor=${encodeURIComponent(cursor)}`, {
        accept: "text/event-stream",
        signal,
      });
    } catch (error) {
      if (signal?.aborted) return;
      await delay(reconnectDelay, signal);
      continue;
    }
    if (!response.ok) {
      const error = await responseError(response);
      if (response.status !== 429 && response.status < 500) throw error;
      await delay(reconnectDelay, signal);
      continue;
    }
    if (!response.body) throw new ManagedError("invalid_response", "managed event stream has no body");

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (!signal?.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += chunk.value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const parsed = parseEventFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (!parsed) continue;
          if (parsed.retry !== undefined) reconnectDelay = parsed.retry;
          if (!parsed.data) continue;
          if (parsed.id !== undefined) cursor = parsed.id;
          const data = parseEventData(parsed.data);
          const eventCursor = parsed.id ?? requiredCursor(data, "cursor");
          cursor = eventCursor;
          yield managedEvent(data, eventCursor, parsed.event);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!signal?.aborted) await delay(reconnectDelay, signal);
  }
}

function managedEvent(data, cursor = requiredCursor(data, "cursor"), fallbackType = "message") {
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.type !== "string") {
    throw new ManagedError("invalid_response", "managed event history contains a malformed event");
  }
  return Object.freeze({
    cursor,
    createdAt: typeof data.created_at === "number" ? data.created_at : undefined,
    turnId: typeof data.turn_id === "string" ? data.turn_id : null,
    type: typeof data.type === "string" ? data.type : fallbackType,
    data: Object.freeze(data),
  });
}

function cursorBefore(left, right) {
  return left.length !== right.length ? left.length < right.length : left < right;
}

function parseEventFrame(frame) {
  let event = "message";
  let id;
  let retry;
  const data = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0") && CURSOR.test(value)) id = value;
    else if (field === "retry" && /^[0-9]+$/.test(value)) retry = Number(value);
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && retry === undefined) return undefined;
  return { event, id, retry, data: data.length === 0 ? undefined : data.join("\n") };
}

function parseEventData(encoded) {
  try {
    const data = JSON.parse(encoded);
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.type !== "string") {
      throw new Error("event is not an object");
    }
    return data;
  } catch (error) {
    throw new ManagedError("invalid_event", "managed event data is malformed", { cause: error });
  }
}

function managedClient(options) {
  validateOptions(options);
  const baseUrl = managedBaseUrl(options.baseUrl);
  const apiKey = options.apiKey;
  if (apiKey !== undefined && (typeof apiKey !== "string" || !API_KEY.test(apiKey))) {
    throw new TypeError("managed API key must be an ncx_live bearer key");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in this runtime");

  const response = async (path, init = {}) => {
    const headers = new Headers();
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (init.accept) headers.set("accept", init.accept);
    if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
    if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
    return fetchImpl(new URL(path, baseUrl), {
      method: init.method ?? "GET",
      headers,
      credentials: apiKey ? "omit" : "include",
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  };
  return Object.freeze({
    response,
    async json(path, init) {
      const result = await response(path, init);
      if (!result.ok) throw await responseError(result);
      try {
        return await result.json();
      } catch (error) {
        throw new ManagedError("invalid_response", "managed response is not valid JSON", {
          status: result.status,
          cause: error,
        });
      }
    },
    async empty(path, init) {
      const result = await response(path, init);
      if (!result.ok) throw await responseError(result);
      await result.body?.cancel();
    },
  });
}

async function responseError(response) {
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  const code = typeof body?.error === "string" ? body.error : `http_${response.status}`;
  const message = typeof body?.message === "string" ? body.message : `managed request failed (${response.status})`;
  return new ManagedError(code, message, { status: response.status });
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("managed agent options must be an object");
  }
  const unsupported = Object.keys(options).find((key) => !ALLOWED_OPTIONS.has(key));
  if (unsupported) throw new TypeError(`managed agents do not accept ${unsupported}`);
}

function managedBaseUrl(value) {
  const fallback = globalThis.location?.origin;
  if (value === undefined && !fallback) {
    throw new TypeError("managed Agent requires baseUrl outside a browser");
  }
  const url = new URL(value ?? fallback);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError("managed baseUrl must be an HTTP(S) origin");
  }
  url.pathname = "/";
  return url;
}

function agentPath(id) {
  return `/v1/agents/${encodeURIComponent(id)}`;
}

function turnPath(agentId, turnId) {
  return `${agentPath(agentId)}/turns/${encodeURIComponent(turnId)}`;
}

function validateAgentId(id) {
  if (typeof id !== "string" || !TURN_ID.test(id)) {
    throw new TypeError("managed agent id is invalid");
  }
}

function requiredString(value, field) {
  const result = value?.[field];
  if (typeof result !== "string" || result.length === 0) {
    throw new ManagedError("invalid_response", `managed response has no ${field}`);
  }
  return result;
}

function requiredCursor(value, field) {
  const cursor = value?.[field];
  if (typeof cursor !== "string" || !CURSOR.test(cursor)) {
    throw new ManagedError("invalid_response", `managed response has no valid ${field}`);
  }
  return cursor;
}

function generatedIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new TypeError("managed prompt requires idempotencyKey when crypto.randomUUID is unavailable");
  }
  return `ncx-${globalThis.crypto.randomUUID()}`;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value ? value : fallback;
}

function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal.reason));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}
