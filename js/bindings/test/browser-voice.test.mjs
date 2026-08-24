import assert from "node:assert/strict";
import { test } from "node:test";

import { agentActions } from "../actions/index.mjs";
import { Actions, Voice } from "../browser/index.mjs";
import { BrowserVoiceSession, SpeakerPlayback } from "../browser/VoiceSession.mjs";
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

function fakeVoiceCore(calls) {
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

function installBrowserVoiceFixture() {
  const previous = {
    RTCPeerConnection: globalThis.RTCPeerConnection,
    WebSocket: globalThis.WebSocket,
    fetch: globalThis.fetch,
    location: globalThis.location,
    window: globalThis.window,
  };
  const fixture = { request: undefined, sideband: undefined };
  class FakePeer {
    connectionState = "connected";
    iceGatheringState = "complete";
    localDescription;
    signalingState = "stable";
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
    constructor() {
      fixture.sideband = this;
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
    return new Response("v=answer", {
      headers: { "x-nanocodex-realtime-location": "/v1/live/rtc_test" },
    });
  };
  return {
    get request() { return fixture.request; },
    get sideband() { return fixture.sideband; },
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
