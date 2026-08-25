import { ManagedError } from "./ManagedError.mjs";
import { registerManagedAgent } from "./internal.mjs";

const API_KEY = /^ncx_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/;
const CURSOR = /^(?:0|[1-9][0-9]*)$/;
const LATEST_CURSOR = "latest";
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TERMINAL_TYPES = new Set([
  "turn_completed",
  "turn_cancelled",
  "turn_blocked",
  "turn_failed",
]);
const TERMINAL_CACHE_CAPACITY = 256;
const TERMINAL_CACHE_BYTES = 8 * 1024 * 1024;
const SUBSCRIBER_QUEUE_CAPACITY = 4_096;
const SUBSCRIBER_QUEUE_BYTES = 32 * 1024 * 1024;
const EVENT_STREAM_FRAME_BYTES = 2 * 1024 * 1024;
const EVENT_STREAM_INACTIVITY_TIMEOUT_MS = 45_000;
const TURN_SUBMISSION_TIMEOUT_MS = 10_000;
const TURN_STATE_POLL_INITIAL_MS = 1_000;
const TURN_STATE_POLL_MAX_MS = 5_000;
const ALLOWED_OPTIONS = new Set(["apiKey", "baseUrl", "fetch"]);
const eventEncoder = new TextEncoder();

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
  const summaries = body.summaries === undefined ? {} : body.summaries;
  if (!summaries || typeof summaries !== "object" || Array.isArray(summaries)) {
    throw new ManagedError("invalid_response", "managed agent summaries are malformed");
  }
  return Object.freeze(body.data.map((id) => agentHandle(
    client,
    id,
    Object.hasOwn(summaries, id) ? managedSummary(summaries[id]) : undefined,
  )));
}

/** Resolve one owned managed agent and verify that it exists. */
export async function get(id, options = {}) {
  validateAgentId(id);
  const client = managedClient(options);
  await client.json(agentPath(id));
  return agentHandle(client, id);
}

/** Open a managed agent handle without probing retained state first. */
export function open(id, options = {}) {
  validateAgentId(id);
  return agentHandle(managedClient(options), id);
}

/** Delete one owned managed agent and all of its retained state. */
export async function remove(id, options = {}) {
  validateAgentId(id);
  const client = managedClient(options);
  await client.empty(agentPath(id), { method: "DELETE" });
}

export { remove as delete };

function agentHandle(client, id, summary) {
  validateAgentId(id);
  const eventStream = replayableEventStream(client, id);
  const events = Object.freeze({
    page: (options = {}) => eventHistoryPage(client, id, options),
    watch: (options = {}) => eventStream.subscribe(options),
  });
  const agent = Object.freeze({
    type: "managed",
    id,
    ...(summary === undefined ? {} : { summary }),
    events,
    turn: Object.freeze({
      prompt: (options) => managedTurn(client, id, eventStream, options),
    }),
    state: () => client.json(agentPath(id)),
    delete: async () => {
      await client.empty(agentPath(id), { method: "DELETE" });
      eventStream.close();
    },
  });
  registerManagedAgent(agent, client, id);
  return agent;
}

function managedSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.title !== "string"
    || !nonnegativeNumber(value.created_at)
    || !nonnegativeNumber(value.updated_at)
    || !Number.isSafeInteger(value.turn_count) || value.turn_count < 0) {
    throw new ManagedError("invalid_response", "managed agent summary is malformed");
  }
  return Object.freeze({
    title: value.title,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    turnCount: value.turn_count,
  });
}

function nonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
  const body = await client.json(`${agentPath(agentId)}/events/history?${query}`, {
    signal: options.signal,
  });
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
  void submission.catch(() => {});
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
      const turnId = id ?? requiredString(await submission, "turn_id");
      return client.json(`${turnPath(agentId, turnId)}/cancel`, {
        method: "POST",
      });
    },
    result: (options = {}) => {
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("managed turn result options must be an object");
      }
      const observerSignal = options.signal;
      if (observerSignal !== undefined && !(observerSignal instanceof AbortSignal)) {
        throw new TypeError("managed turn result signal must be an AbortSignal");
      }
      return observerSignal === undefined
        ? result ??= waitForResult(client, agentId, eventStream, submission, signal)
        : waitForResult(client, agentId, eventStream, submission, observerSignal);
    },
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
      return await boundedSubmission(client, `${agentPath(agentId)}/turns`, {
        method: "POST",
        body,
        idempotencyKey: options.idempotencyKey,
      }, options.signal);
    } catch (error) {
      if (options.signal?.aborted
        || (error instanceof ManagedError && error.code !== "network_error")) throw error;
      failure = error;
      if (attempt < 2) await delay(150 * (attempt + 1), options.signal);
    }
  }
  throw failure;
}

async function boundedSubmission(client, path, init, signal) {
  const attempt = new AbortController();
  let rejectBoundary;
  const boundary = new Promise((_, reject) => { rejectBoundary = reject; });
  const interrupt = (reason) => {
    if (attempt.signal.aborted) return;
    attempt.abort(reason);
    rejectBoundary(reason);
  };
  const aborted = () => interrupt(abortError(signal.reason));
  if (signal?.aborted) aborted();
  else signal?.addEventListener("abort", aborted, { once: true });
  const timeout = setTimeout(() => interrupt(new ManagedError(
    "network_error",
    "Managed agent submission was not acknowledged. Retrying the same durable turn.",
  )), TURN_SUBMISSION_TIMEOUT_MS);
  timeout.unref?.();
  const request = client.json(path, { ...init, signal: attempt.signal });
  void request.catch(() => {});
  try {
    return await Promise.race([request, boundary]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", aborted);
  }
}

async function waitForResult(client, agentId, eventStream, submission, signal) {
  const accepted = await observePromise(submission, signal);
  const turnId = requiredString(accepted, "turn_id");
  if (accepted.terminal) return terminalResult(turnId, accepted.terminal, accepted.terminal_cursor);
  const cursor = requiredCursor(accepted, "accepted_cursor");
  const events = eventStream.subscribe({ cursor, signal });
  const pollController = new AbortController();
  const abortPolling = () => pollController.abort(signal?.reason);
  if (signal?.aborted) abortPolling();
  else signal?.addEventListener("abort", abortPolling, { once: true });
  try {
    const retained = eventStream.terminal(turnId, cursor);
    if (retained) return terminalResult(turnId, retained.data, retained.cursor);
    let eventObservation = observedEvent(events);
    let statePollMs = TURN_STATE_POLL_INITIAL_MS;
    let stateObservation = observedTurnState(
      client,
      agentId,
      turnId,
      statePollMs,
      pollController.signal,
    );
    while (true) {
      const observation = await Promise.race([eventObservation, stateObservation]);
      if (observation.kind === "state") {
        if (observation.value?.terminal) {
          return terminalResult(
            turnId,
            observation.value.terminal,
            observation.value.terminal_cursor,
          );
        }
        statePollMs = Math.min(statePollMs * 2, TURN_STATE_POLL_MAX_MS);
        stateObservation = observedTurnState(
          client,
          agentId,
          turnId,
          statePollMs,
          pollController.signal,
        );
        continue;
      }
      if (observation.kind === "event_error") throw observation.error;
      if (observation.value.done) break;
      eventObservation = observedEvent(events);
      const event = observation.value.value;
      const data = event.data;
      if (data.type === "stream_failed") {
        throw new ManagedError("stream_failed", stringOr(data.error, "managed event stream failed"));
      }
      if (data.turn_id !== turnId && data.id !== turnId) continue;
      if (TERMINAL_TYPES.has(data.type)) return terminalResult(turnId, data, event.cursor);
    }
  } finally {
    signal?.removeEventListener("abort", abortPolling);
    pollController.abort();
    await events.return();
  }
  if (signal?.aborted) throw abortError(signal.reason);
  throw new ManagedError("event_stream_ended", "managed event stream ended before the turn completed");
}

function observedEvent(events) {
  return events.next().then(
    (value) => ({ kind: "event", value }),
    (error) => ({ kind: "event_error", error }),
  );
}

async function observedTurnState(client, agentId, turnId, milliseconds, signal) {
  try {
    await delay(milliseconds, signal);
    const value = await client.json(turnPath(agentId, turnId), { signal });
    return { kind: "state", value };
  } catch {
    if (signal.aborted) return { kind: "state", value: undefined };
    // The cursor stream remains the primary low-latency path. State reads are
    // an authoritative recovery path and must not make a healthy stream fail.
    return { kind: "state", value: undefined };
  }
}

function observePromise(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(abortError(signal.reason));
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
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
  const joiningSubscribers = new Set();
  const terminals = new Map();
  let terminalBytes = 0;
  let connection;
  let nextGeneration = 0;
  let closed = false;
  let stopOnlineReconnect;

  const retireConnection = (restart = true) => {
    const retired = connection;
    if (!retired) return;
    connection = undefined;
    retired.controller.abort();
    if (restart) start();
  };

  const watchOnlineReconnect = () => {
    if (stopOnlineReconnect || typeof globalThis.addEventListener !== "function") return;
    const reconnect = () => retireConnection();
    globalThis.addEventListener("online", reconnect);
    stopOnlineReconnect = () => {
      globalThis.removeEventListener?.("online", reconnect);
      stopOnlineReconnect = undefined;
    };
  };

  const remove = (subscriber) => {
    const removed = subscribers.delete(subscriber) || joiningSubscribers.delete(subscriber);
    if (!removed) return;
    subscriber.boundaryController?.abort();
    subscriber.signal?.removeEventListener("abort", subscriber.onAbort);
    if (subscribers.size === 0 && joiningSubscribers.size === 0) {
      stopOnlineReconnect?.();
      retireConnection(false);
    }
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
    subscriber.queue.length = 0;
    subscriber.bufferedBytes = 0;
    return Promise.resolve({ value: undefined, done: true });
  };

  const attach = (subscriber) => {
    if (subscriber.done || closed) return;
    joiningSubscribers.delete(subscriber);
    subscriber.boundaryController = undefined;
    subscribers.add(subscriber);
    watchOnlineReconnect();
    if (
      connection?.cursor !== undefined
      && (
        (connection.startCursor === LATEST_CURSOR && subscriber.cursor !== LATEST_CURSOR)
        || cursorBefore(subscriber.cursor, connection.cursor)
      )
    ) {
      retireConnection();
    } else {
      start();
    }
  };

  const start = () => {
    if (closed || connection || subscribers.size === 0) return;
    const cursor = [...subscribers].reduce(
      (lowest, subscriber) => cursorBefore(subscriber.cursor, lowest) ? subscriber.cursor : lowest,
      [...subscribers][0].cursor,
    );
    const controller = new AbortController();
    const current = {
      controller,
      cursor,
      startCursor: cursor,
      generation: nextGeneration += 1,
      running: undefined,
    };
    connection = current;
    const running = (async () => {
      try {
        for await (const event of readEvents(
          client,
          agentId,
          cursor,
          controller.signal,
          (controlCursor) => {
            if (connection !== current) return;
            current.cursor = controlCursor;
            for (const subscriber of subscribers) {
              if (subscriber.cursor !== LATEST_CURSOR) continue;
              subscriber.cursor = controlCursor;
              subscriber.deliveredCursor = controlCursor;
            }
          },
        )) {
          if (connection !== current) return;
          current.cursor = event.cursor;
          const turnId = event.data.turn_id ?? event.data.id;
          if (typeof turnId === "string" && TERMINAL_TYPES.has(event.data.type)) {
            const retained = terminals.get(turnId);
            if (retained) {
              if (sameTerminal(retained.event.data, event.data)) continue;
              throw new ManagedError(
                "conflicting_terminal",
                `managed turn ${turnId} published conflicting terminal events`,
              );
            }
            const bytes = encodedBytes(event);
            if (bytes <= TERMINAL_CACHE_BYTES) {
              terminals.set(turnId, { bytes, event });
              terminalBytes += bytes;
              while (
                terminals.size > TERMINAL_CACHE_CAPACITY
                || terminalBytes > TERMINAL_CACHE_BYTES
              ) {
                const oldestTurnId = terminals.keys().next().value;
                const oldest = terminals.get(oldestTurnId);
                terminals.delete(oldestTurnId);
                terminalBytes -= oldest.bytes;
              }
            }
          }
          for (const subscriber of subscribers) {
            if (!eventAfter(subscriber.cursor, event.cursor)) continue;
            subscriber.cursor = event.cursor;
            if (subscriber.pending) {
              const pending = subscriber.pending;
              subscriber.pending = undefined;
              subscriber.deliveredCursor = event.cursor;
              pending.resolve({ value: event, done: false });
            } else {
              const bytes = encodedBytes(event.data);
              if (
                subscriber.queue.length >= SUBSCRIBER_QUEUE_CAPACITY
                || subscriber.bufferedBytes + bytes > SUBSCRIBER_QUEUE_BYTES
              ) {
                subscriber.overflowed = true;
                subscriber.done = true;
                remove(subscriber);
                continue;
              }
              subscriber.queue.push({ bytes, event });
              subscriber.bufferedBytes += bytes;
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
    current.running = running;
    void running.finally(() => {
      if (connection !== current) return;
      connection = undefined;
      start();
    });
  };

  const subscribe = (options = {}) => {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("managed event options must be an object");
    }
    const cursor = options.cursor ?? "0";
    if (typeof cursor !== "string" || (cursor !== LATEST_CURSOR && !CURSOR.test(cursor))) {
      throw new TypeError("managed event cursor must be an unsigned decimal string or latest");
    }
    if (closed) throw new ManagedError("agent_closed", "managed agent event stream is closed");

    const subscriber = {
      cursor,
      deliveredCursor: cursor,
      queue: [],
      bufferedBytes: 0,
      pending: undefined,
      done: false,
      error: undefined,
      overflowed: false,
      overflowReported: false,
      boundaryController: undefined,
      signal: options.signal,
      onAbort: undefined,
    };
    const iterator = {
      next() {
        if (subscriber.queue.length > 0) {
          const entry = subscriber.queue.shift();
          subscriber.bufferedBytes -= entry.bytes;
          subscriber.deliveredCursor = entry.event.cursor;
          return Promise.resolve({ value: entry.event, done: false });
        }
        if (subscriber.error) return Promise.reject(subscriber.error);
        if (subscriber.overflowed && !subscriber.overflowReported) {
          subscriber.overflowReported = true;
          return Promise.reject(new ManagedError(
            "event_backlog_exceeded",
            `managed event iterator exceeded its private buffer of ${SUBSCRIBER_QUEUE_CAPACITY} events or `
              + `${SUBSCRIBER_QUEUE_BYTES} encoded bytes; reconnect with events.watch({ cursor: `
              + `"${subscriber.deliveredCursor}" })`,
          ));
        }
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
    if (cursor === LATEST_CURSOR && (connection !== undefined || subscribers.size > 0)) {
      subscriber.boundaryController = new AbortController();
      joiningSubscribers.add(subscriber);
      watchOnlineReconnect();
      void resolveLatestCursor(client, agentId, subscriber.boundaryController.signal).then(
        (boundary) => {
          subscriber.cursor = boundary;
          subscriber.deliveredCursor = boundary;
          attach(subscriber);
        },
        (error) => {
          if (subscriber.done) return;
          finish(subscriber, error);
          remove(subscriber);
        },
      );
    } else {
      attach(subscriber);
    }
    return Object.freeze(iterator);
  };

  return Object.freeze({
    subscribe,
    terminal(turnId, afterCursor) {
      const event = terminals.get(turnId)?.event;
      return event && cursorBefore(afterCursor, event.cursor) ? event : undefined;
    },
    close() {
      if (closed) return;
      closed = true;
      stopOnlineReconnect?.();
      retireConnection(false);
      for (const subscriber of subscribers) finish(subscriber);
      for (const subscriber of [...subscribers]) remove(subscriber);
      for (const subscriber of joiningSubscribers) finish(subscriber);
      for (const subscriber of [...joiningSubscribers]) remove(subscriber);
      terminals.clear();
      terminalBytes = 0;
    },
  });
}

async function resolveLatestCursor(client, agentId, signal) {
  const controller = new AbortController();
  const aborted = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", aborted, { once: true });
  let boundary;
  try {
    for await (const _event of readEvents(
      client,
      agentId,
      LATEST_CURSOR,
      controller.signal,
      (cursor) => {
        boundary = cursor;
        controller.abort();
      },
    )) {
      if (boundary !== undefined) break;
    }
  } finally {
    signal?.removeEventListener("abort", aborted);
  }
  if (boundary !== undefined) return boundary;
  if (signal?.aborted) throw abortError(signal.reason);
  throw new ManagedError(
    "event_stream_ended",
    "managed event stream ended before establishing the latest cursor boundary",
  );
}

async function* readEvents(client, agentId, initialCursor, signal, onControlCursor) {
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
    if (signal?.aborted) {
      void response.body?.cancel().catch(() => {});
      return;
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
        let chunk;
        try {
          chunk = await readEventChunk(reader, signal);
        } catch {
          if (signal?.aborted) return;
          break;
        }
        if (chunk.done) break;
        buffer += chunk.value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        assertEventFrameSize(buffer);
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const frame = buffer.slice(0, boundary);
          assertEventFrameSize(frame);
          const parsed = parseEventFrame(frame);
          buffer = buffer.slice(boundary + 2);
          if (!parsed) continue;
          if (parsed.retry !== undefined) reconnectDelay = parsed.retry;
          if (parsed.controlCursor !== undefined) {
            cursor = parsed.controlCursor;
            onControlCursor?.(cursor);
          }
          if (!parsed.data) continue;
          if (parsed.id !== undefined) cursor = parsed.id;
          const data = parseEventData(parsed.data);
          const eventCursor = parsed.id ?? requiredCursor(data, "cursor");
          cursor = eventCursor;
          yield managedEvent(data, eventCursor, parsed.event);
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (!signal?.aborted) await delay(reconnectDelay, signal);
  }
}

function assertEventFrameSize(frame) {
  if (encodedBytes(frame) <= EVENT_STREAM_FRAME_BYTES) return;
  throw new ManagedError(
    "event_frame_too_large",
    `managed event frame exceeds ${EVENT_STREAM_FRAME_BYTES} decoded bytes`,
  );
}

function encodedBytes(value) {
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  return eventEncoder.encode(encoded).byteLength;
}

function sameTerminal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readEventChunk(reader, signal) {
  let timeout;
  let onAbort;
  const pending = reader.read();
  void pending.catch(() => {});
  const interrupted = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ManagedError(
        "event_stream_inactive",
        `managed event stream was inactive for ${EVENT_STREAM_INACTIVITY_TIMEOUT_MS}ms`,
      ));
    }, EVENT_STREAM_INACTIVITY_TIMEOUT_MS);
    onAbort = () => reject(abortError(signal?.reason));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
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
  if (left === LATEST_CURSOR) return false;
  if (right === LATEST_CURSOR) return true;
  return left.length !== right.length ? left.length < right.length : left < right;
}

function eventAfter(cursor, eventCursor) {
  return cursor === LATEST_CURSOR || cursorBefore(cursor, eventCursor);
}

function parseEventFrame(frame) {
  let event = "message";
  let id;
  let retry;
  let controlCursor;
  const data = [];
  for (const line of frame.split("\n")) {
    if (!line) continue;
    if (line.startsWith(":")) {
      const comment = line.slice(1).trimStart();
      if (comment.startsWith("cursor ")) {
        const value = comment.slice("cursor ".length);
        if (CURSOR.test(value)) controlCursor = value;
      }
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0") && CURSOR.test(value)) id = value;
    else if (field === "retry" && /^[0-9]+$/.test(value)) retry = Number(value);
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && retry === undefined && controlCursor === undefined) return undefined;
  return { event, id, retry, controlCursor, data: data.length === 0 ? undefined : data.join("\n") };
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
    try {
      return await fetchImpl(new URL(path, baseUrl), {
        method: init.method ?? "GET",
        headers,
        credentials: apiKey ? "omit" : "include",
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
    } catch (error) {
      if (init.signal?.aborted) throw abortError(init.signal.reason);
      throw new ManagedError(
        "network_error",
        "Managed agent connection was interrupted. Check your network and retry.",
        { cause: error },
      );
    }
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
