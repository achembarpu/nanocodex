import assert from "node:assert/strict";
import { test } from "node:test";

import { agentActions } from "../actions/index.mjs";
import { Actions, Voice } from "../browser/index.mjs";
import {
  BrowserVoiceSession,
  capturePreferredMicrophone,
  SpeakerPlayback,
} from "../browser/VoiceSession.mjs";
import { createAgentClient, defineRuntime } from "../internal.mjs";

test("browser voice exposes Codex's ChatGPT V3 catalog and default", () => {
  assert.deepEqual(Voice.voices, [
    "juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove",
  ]);
  assert.equal(Voice.defaultVoice, "cove");
  assert.throws(() => Voice.create({}), /Nanocodex Agent/);
});

test("the public resource is a thin binding over the Rust voice controller", async () => {
  const fixture = installBrowserVoiceFixture();
  try {
    const calls = [];
    const core = fakeVoiceCore(calls);
    const { agent, emitAgentEvent } = await testAgent(core, calls);
    const voice = Actions.voice.create(agent, {
      beforeAgentTurn: async () => { calls.push(["fence"]); },
      captureMicrophone: async () => {
        calls.push(["microphone"]);
        return fakeMicrophone(calls);
      },
    });

    await Actions.voice.start(voice, { voice: "juniper" });
    assert.equal(Actions.voice.getSnapshot(voice).status, "active");
    assert.deepEqual(calls.slice(0, 5), [
      ["microphone"],
      ["browserVoice", "juniper"],
      ["fence"],
      ["start"],
      ["callBody", "v=offer"],
    ]);
    assert.equal(calls.some(([kind]) => kind === "completeCall"), true);
    assert.equal(calls.some(([kind]) => kind === "sidebandUrl"), true);
    assert.equal(fixture.request.session_id, "agent-session");
    assert.deepEqual(JSON.parse(fixture.request.call_body), {
      sdp: "v=offer",
      session: { delegation: { type: "client" } },
    });

    fixture.sideband.message({ type: "delegation.created" });
    await waitFor(() => fixture.sideband.sent.includes('{"type":"rust.frame"}'));
    assert.equal(calls.filter(([kind]) => kind === "fence").length, 2);
    emitAgentEvent({ type: "assistant.message", payload: { text: "done" } });
    await waitFor(() => calls.some(([kind]) => kind === "agentEvent"));
    assert.deepEqual(JSON.parse(calls.find(([kind]) => kind === "agentEvent")[1]), {
      type: "event",
      target: { pane: "main", branchId: "agent-session" },
      event: { type: "assistant.message", payload: { text: "done" } },
    });

    const firstSideband = fixture.sideband;
    firstSideband.close();
    await waitFor(() => calls.some(([kind]) => kind === "sidebandClosed"));
    await new Promise((resolve) => setTimeout(resolve, 210));
    await waitFor(() => fixture.sideband !== firstSideband);
    assert.equal(
      calls.filter(([kind]) => kind === "sidebandOpened").length,
      2,
    );

    await Actions.voice.stop(voice);
    assert.equal(Actions.voice.getSnapshot(voice).status, "idle");
    assert.equal(calls.filter(([kind]) => kind === "fence").length, 3);
    assert.equal(calls.some(([kind]) => kind === "stop"), true);
    assert.equal(calls.some(([kind]) => kind === "free"), true);
    assert.equal(fixture.sideband.sent.includes('{"type":"session.close"}'), true);
    agent.dispose();
  } finally {
    fixture.restore();
  }
});

test("requests the microphone before waiting for the Rust controller", async () => {
  const fixture = installBrowserVoiceFixture();
  try {
    const order = [];
    let resolveCore;
    const core = new Promise((resolve) => { resolveCore = resolve; });
    const session = new BrowserVoiceSession({
      core,
      sessionId: "mobile-session",
      voice: "cove",
      captureMicrophone() {
        order.push("microphone");
        return Promise.resolve(fakeMicrophone(order));
      },
      onStatus() {},
      onTranscript() {},
      onTerminated() {},
    });

    const starting = session.start();
    assert.equal(order[0], "microphone");
    session.abort();
    resolveCore(fakeVoiceCore(order));
    await starting;
    assert.equal(order.some((entry) => Array.isArray(entry) && entry[0] === "track.stop"), true);
  } finally {
    fixture.restore();
  }
});

test("explains browser and embed microphone denials", async () => {
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  };
  const denial = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => { throw denial; } } },
    });
    globalThis.window = { top: {} };
    globalThis.document = { permissionsPolicy: { allowsFeature: () => false } };
    await assert.rejects(
      capturePreferredMicrophone(async () => undefined),
      /host iframe must allow="microphone"/,
    );

    const topWindow = {};
    topWindow.top = topWindow;
    globalThis.window = topWindow;
    globalThis.document = { permissionsPolicy: { allowsFeature: () => true } };
    await assert.rejects(
      capturePreferredMicrophone(async () => undefined),
      /Allow it in your browser settings, then retry/,
    );
  } finally {
    restoreGlobal("document", previous.document);
    restoreGlobal("navigator", previous.navigator);
    restoreGlobal("window", previous.window);
  }
});

test("refreshes an asynchronous sideband authorization before reconnecting", async () => {
  const fixture = installBrowserVoiceFixture();
  const calls = [];
  let tickets = 0;
  try {
    const session = new BrowserVoiceSession({
      core: fakeVoiceCore(calls),
      sessionId: "connect-agent",
      voice: "cove",
      captureMicrophone: async () => fakeMicrophone(calls),
      call: async () => new Response("v=answer", {
        headers: { "x-nanocodex-realtime-location": "/v1/live/rtc_connect" },
      }),
      async sidebandUrl(callId) {
        tickets += 1;
        return `wss://connect.example/sideband?call_id=${callId}&ticket=${tickets}`;
      },
      onStatus() {},
      onTranscript() {},
      onTerminated() {},
    });
    await session.start();
    assert.match(fixture.sidebandUrls[0], /ticket=1$/);
    const first = fixture.sideband;
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 210));
    await waitFor(() => fixture.sideband !== first);
    assert.match(fixture.sidebandUrls[1], /ticket=2$/);
    await session.close();
  } finally {
    fixture.restore();
  }
});

test("stop tears browser media down while startup boundaries are stalled", async () => {
  for (const boundary of ["ice", "fetch", "sideband"]) {
    const fixture = installBrowserVoiceFixture({ boundary });
    const calls = [];
    try {
      const session = new BrowserVoiceSession({
        core: fakeVoiceCore(calls),
        sessionId: `stalled-${boundary}`,
        voice: "cove",
        captureMicrophone: async () => fakeMicrophone(calls),
        onStatus() {},
        onTranscript() {},
        onTerminated() {},
      });
      const starting = session.start();
      await waitFor(() => (
        boundary === "ice" ? fixture.peer !== undefined
          : boundary === "fetch" ? fixture.requestSignal !== undefined
            : fixture.sideband !== undefined
      ));
      await Promise.race([
        session.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${boundary} stop timed out`)), 100)),
      ]);
      if (boundary !== "fetch") await starting.catch(() => {});
      assert.equal(calls.some(([kind]) => kind === "track.stop"), true, boundary);
      if (boundary === "fetch") assert.equal(fixture.requestSignal.aborted, true);
    } finally {
      fixture.restore();
    }
  }
});

test("starts waiting on one stop coalesce into one replacement session", async () => {
  const fixture = installBrowserVoiceFixture();
  const calls = [];
  let releaseStop;
  let stopCount = 0;
  const core = fakeVoiceCore(calls, {
    async stop() {
      stopCount += 1;
      if (stopCount === 1) await new Promise((resolve) => { releaseStop = resolve; });
      return JSON.stringify({ frames: [], transcripts: [], schedule_flush: false });
    },
  });
  try {
    const { agent } = await testAgent(core, calls);
    const voice = Actions.voice.create(agent, {
      captureMicrophone: async () => {
        calls.push(["microphone"]);
        return fakeMicrophone(calls);
      },
    });
    await voice.start();
    const stopping = voice.stop();
    await waitFor(() => typeof releaseStop === "function");
    const first = voice.start();
    const second = voice.start();
    releaseStop();
    await Promise.all([stopping, first, second]);
    assert.equal(calls.filter(([kind]) => kind === "microphone").length, 2);
    await voice.stop();
    agent.dispose();
  } finally {
    fixture.restore();
  }
});

test("speaker playback resumes from the next user gesture when autoplay is blocked", async () => {
  let attempts = 0;
  let resume;
  const speaker = {
    autoplay: false,
    srcObject: null,
    pause() {},
    play() {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("blocked")) : Promise.resolve();
    },
  };
  const gestures = {
    addEventListener(_type, listener) { resume = listener; },
    removeEventListener(_type, listener) { if (resume === listener) resume = undefined; },
  };
  const playback = new SpeakerPlayback(speaker, () => {}, gestures);
  playback.attach({});
  await Promise.resolve();
  await Promise.resolve();
  resume();
  await Promise.resolve();
  assert.equal(attempts, 2);
  playback.close();
});

function fakeVoiceCore(calls, overrides = {}) {
  return {
    async start() { calls.push(["start"]); },
    async callBody(sdp) {
      calls.push(["callBody", sdp]);
      return JSON.stringify({
        session_id: "agent-session",
        call_body: JSON.stringify({ sdp, session: { delegation: { type: "client" } } }),
      });
    },
    async completeCall(body, location) {
      calls.push(["completeCall", body, location]);
      return JSON.stringify({ call_id: "rtc_test", sdp: body });
    },
    async sidebandUrl(callId) {
      calls.push(["sidebandUrl", callId]);
      return `/api/realtime/sideband?call_id=${callId}`;
    },
    async sidebandOpened() {
      calls.push(["sidebandOpened"]);
      return JSON.stringify({ frames: [], transcripts: [], schedule_flush: false });
    },
    async sidebandClosed(connectedMs) {
      calls.push(["sidebandClosed", connectedMs]);
      return JSON.stringify({
        frames: [],
        transcripts: [],
        reconnect_after_ms: 200,
        schedule_flush: false,
      });
    },
    async framesSent(count) { calls.push(["framesSent", count]); },
    async requiresAgentAdmission(payload) {
      calls.push(["requiresAgentAdmission", payload]);
      return JSON.parse(payload).type === "delegation.created";
    },
    async realtimeMessage(payload) {
      calls.push(["realtimeMessage", payload]);
      return JSON.stringify({
        frames: ['{"type":"rust.frame"}'],
        transcripts: [{ speaker: "user", text: "ship it" }],
        acknowledge_frames: true,
        schedule_flush: false,
      });
    },
    async agentEvent(envelope) {
      calls.push(["agentEvent", envelope]);
      return JSON.stringify({ frames: [], transcripts: [], schedule_flush: false });
    },
    async flush(finalChunk) {
      calls.push(["flush", finalChunk]);
      return JSON.stringify({ frames: [], transcripts: [], schedule_flush: false });
    },
    async stop() {
      calls.push(["stop"]);
      return JSON.stringify({
        frames: ['{"type":"session.close"}'],
        transcripts: [],
        status: "Voice stopped",
        schedule_flush: false,
      });
    },
    async cancel() { calls.push(["cancel"]); return true; },
    async preferredPhysicalInput() { return undefined; },
    free() { calls.push(["free"]); },
    ...overrides,
  };
}

async function testAgent(core, calls) {
  let listener;
  const raw = {
    sessionId: "agent-session",
    prompt() { throw new Error("the JS voice binding must not prompt the Agent"); },
    browserVoice(voice) { calls.push(["browserVoice", voice]); return core; },
    free() {},
  };
  const runtime = defineRuntime({
    create: async () => raw,
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    decorate: (agent) => agent.extend(agentActions()),
  });
  return {
    agent: await createAgentClient(runtime),
    emitAgentEvent(event) { listener?.(event); },
  };
}

function fakeMicrophone(calls) {
  return {
    getAudioTracks: () => [],
    getTracks: () => [{ stop: () => calls.push(["track.stop"]) }],
  };
}

function installBrowserVoiceFixture({ boundary } = {}) {
  const previous = {
    RTCPeerConnection: globalThis.RTCPeerConnection,
    WebSocket: globalThis.WebSocket,
    fetch: globalThis.fetch,
    location: globalThis.location,
    window: globalThis.window,
  };
  const fixture = {
    peer: undefined,
    request: undefined,
    requestSignal: undefined,
    sideband: undefined,
    sidebandUrls: [],
  };
  class FakePeer {
    connectionState = "connected";
    iceGatheringState = boundary === "ice" ? "gathering" : "complete";
    localDescription;
    signalingState = "stable";
    constructor() { fixture.peer = this; }
    addEventListener() {}
    removeEventListener() {}
    addTrack() {}
    close() { this.signalingState = "closed"; }
    createDataChannel() { return { close() {} }; }
    async createOffer() { return { type: "offer", sdp: "v=offer" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription() {}
  }
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    listeners = new Map();
    sent = [];
    constructor(url) {
      fixture.sidebandUrls.push(String(url));
      fixture.sideband = this;
      if (boundary === "sideband") return;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open", {});
      });
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    message(value) { this.emit("message", { data: JSON.stringify(value) }); }
    send(value) { this.sent.push(value); }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", {});
    }
  }
  globalThis.location = new URL("https://example.test/agent");
  globalThis.window = { clearTimeout, location: globalThis.location, setTimeout };
  globalThis.RTCPeerConnection = FakePeer;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (_url, init) => {
    fixture.request = JSON.parse(init.body);
    fixture.requestSignal = init.signal;
    if (boundary === "fetch") return new Promise(() => {});
    return new Response("v=answer", {
      headers: { "x-nanocodex-realtime-location": "/v1/live/rtc_test" },
    });
  };
  return {
    get request() { return fixture.request; },
    get requestSignal() { return fixture.requestSignal; },
    get peer() { return fixture.peer; },
    get sideband() { return fixture.sideband; },
    get sidebandUrls() { return fixture.sidebandUrls; },
    restore() { Object.assign(globalThis, previous); },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}
