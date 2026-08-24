import { createBrowserVoice } from "../internal.mjs";
import { BrowserVoiceSession } from "./VoiceSession.mjs";

export const voices = Object.freeze([
  "juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove",
]);
export const defaultVoice = "cove";

const IDLE_SNAPSHOT = Object.freeze({
  error: undefined,
  status: "idle",
  statusText: undefined,
  transcripts: Object.freeze([]),
  voice: undefined,
});

/** Creates a thin browser binding over the Rust-owned Codex voice controller. */
export function create(agent, options = {}) {
  validateAgent(agent);
  validateOptions(options);
  const listeners = new Set();
  const eventListeners = new Set();
  const target = Object.freeze({ pane: "main", branchId: agent.sessionId });
  let snapshot = IDLE_SNAPSHOT;
  let session;
  let startPromise;
  let stopPromise;
  let watcher;
  let releaseEvents;
  let destroyed = false;
  let generation = 0;

  function publish(next) {
    snapshot = Object.freeze({
      error: next.error,
      status: next.status,
      statusText: next.statusText,
      transcripts: next.transcripts ?? snapshot.transcripts,
      voice: next.voice,
    });
    for (const listener of listeners) listener();
  }

  function emit(event) {
    for (const listener of eventListeners) listener(event);
  }

  function cleanupWatcher() {
    releaseEvents?.();
    releaseEvents = undefined;
    watcher?.off();
    watcher = undefined;
  }

  function observeAgentEvents(active) {
    watcher = agent.events.watch({ includeAllSessions: false });
    releaseEvents = watcher.onEvent((event) => active.observe({ type: "event", target, event }));
  }

  async function start(parameters = {}) {
    if (destroyed) throw new Error("voice resource is destroyed");
    const selectedVoice = parameters.voice ?? options.voice ?? defaultVoice;
    if (!voices.includes(selectedVoice)) throw new TypeError(`unsupported ChatGPT voice: ${selectedVoice}`);
    if (session) return startPromise;
    if (stopPromise) await stopPromise;
    const current = ++generation;
    publish({
      error: undefined,
      status: "connecting",
      statusText: undefined,
      transcripts: snapshot.transcripts,
      voice: selectedVoice,
    });
    emit(Object.freeze({ type: "connecting", voice: selectedVoice }));

    const core = Promise.resolve().then(() => createBrowserVoice(agent, selectedVoice));
    const next = new BrowserVoiceSession({
      core,
      sessionId: agent.sessionId,
      voice: selectedVoice,
      ...(options.callUrl === undefined ? {} : { callUrl: options.callUrl }),
      ...(options.sidebandUrl === undefined ? {} : { sidebandUrl: options.sidebandUrl }),
      ...(options.captureMicrophone === undefined ? {} : { captureMicrophone: options.captureMicrophone }),
      ...(options.beforeAgentTurn === undefined ? {} : { beforeAgentTurn: options.beforeAgentTurn }),
      onStatus(text) {
        if (snapshot.status !== "idle" && snapshot.status !== "error") {
          publish({ ...snapshot, statusText: text });
        }
      },
      onTranscript(speaker, text) {
        if (!text.trim()) return;
        const entry = Object.freeze({ speaker, text });
        publish({ ...snapshot, transcripts: Object.freeze([...snapshot.transcripts, entry]) });
        emit(Object.freeze({ type: "transcript", ...entry }));
      },
      onTerminated(message) {
        if (session !== next || destroyed) return;
        session = undefined;
        cleanupWatcher();
        void next.close().catch(() => next.abort());
        const error = new Error(message);
        publish({ ...snapshot, error, status: "error", statusText: message });
        emit(Object.freeze({ type: "error", error }));
      },
    });
    session = next;
    observeAgentEvents(next);
    startPromise = next.start().then(() => {
      if (destroyed || session !== next || generation !== current) return;
      publish({ ...snapshot, error: undefined, status: "active", statusText: `Voice active (${selectedVoice})` });
      emit(Object.freeze({ type: "started", voice: selectedVoice }));
    }).catch(async (cause) => {
      if (session === next) session = undefined;
      cleanupWatcher();
      await next.close().catch(() => next.abort());
      if (destroyed || generation !== current) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      publish({ ...snapshot, error, status: "error", statusText: error.message });
      emit(Object.freeze({ type: "error", error }));
      throw error;
    }).finally(() => {
      if (generation === current) startPromise = undefined;
    });
    return startPromise;
  }

  async function stop() {
    generation += 1;
    if (stopPromise) return stopPromise;
    const active = session;
    session = undefined;
    cleanupWatcher();
    if (!active) {
      if (snapshot.status !== "idle") publish(IDLE_SNAPSHOT);
      return;
    }
    stopPromise = active.close().then(() => {
      if (!destroyed) {
        publish(IDLE_SNAPSHOT);
        emit(Object.freeze({ type: "stopped" }));
      }
    }).finally(() => { stopPromise = undefined; });
    return stopPromise;
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    const active = session;
    session = undefined;
    cleanupWatcher();
    if (active) await active.close().catch(() => active.abort());
    listeners.clear();
    eventListeners.clear();
  }

  return Object.freeze({
    cancel: () => session?.cancel() ?? Promise.resolve(false),
    destroy,
    getSnapshot: () => snapshot,
    onEvent(listener) {
      if (typeof listener !== "function") throw new TypeError("voice event listener must be a function");
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    start,
    stop,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("voice listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle: (parameters) => session ? stop() : start(parameters),
  });
}

function validateAgent(agent) {
  if (!agent || typeof agent !== "object" || typeof agent.sessionId !== "string" || typeof agent.events?.watch !== "function") {
    throw new TypeError("Voice.create requires a Nanocodex Agent");
  }
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Voice.create options must be an object");
  }
  if (options.captureMicrophone !== undefined && typeof options.captureMicrophone !== "function") {
    throw new TypeError("voice captureMicrophone must be a function");
  }
  if (options.beforeAgentTurn !== undefined && typeof options.beforeAgentTurn !== "function") {
    throw new TypeError("voice beforeAgentTurn must be a function");
  }
}
