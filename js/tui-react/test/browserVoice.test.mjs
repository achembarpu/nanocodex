import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHATGPT_VOICES,
  BrowserVoiceSession,
  HandoffStream,
  parseVoiceArgument,
  preferredPhysicalInput,
  browserVoiceStartupContext,
} from "../dist/index.js";
import { SpeakerPlayback } from "../dist/browserVoice.js";

test("parses browser voice commands against the ChatGPT catalog", () => {
  assert.deepEqual(parseVoiceArgument(undefined), { action: "toggle" });
  assert.deepEqual(parseVoiceArgument("off"), { action: "stop" });
  assert.deepEqual(parseVoiceArgument("list"), { action: "list" });
  assert.deepEqual(parseVoiceArgument("on"), { action: "start", voice: "cove" });
  for (const voice of CHATGPT_VOICES) {
    assert.deepEqual(parseVoiceArgument(voice.toUpperCase()), { action: "start", voice });
  }
  assert.equal(parseVoiceArgument("unknown").action, "invalid");
});

test("replaces a virtual default input with the built-in microphone", () => {
  const devices = [
    { kind: "audioinput", deviceId: "virtual", label: "BlackHole 2ch (Virtual)" },
    { kind: "audioinput", deviceId: "usb", label: "USB microphone" },
    { kind: "audioinput", deviceId: "built-in", label: "MacBook Pro Microphone" },
  ];
  assert.equal(
    preferredPhysicalInput(devices, "BlackHole 2ch (Virtual)")?.deviceId,
    "built-in",
  );
  assert.equal(preferredPhysicalInput(devices, "USB microphone"), undefined);
});

test("retries blocked speaker playback from the next activating click", async () => {
  let attempts = 0;
  let resume;
  const statuses = [];
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
    addEventListener(type, listener) {
      assert.equal(type, "click");
      resume = listener;
    },
    removeEventListener(type, listener) {
      assert.equal(type, "click");
      if (resume === listener) resume = undefined;
    },
  };
  const playback = new SpeakerPlayback(speaker, (status) => statuses.push(status), gestures);
  playback.attach({});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.match(statuses.at(-1) ?? "", /tap once/);
  assert.equal(typeof resume, "function");

  resume({ type: "click" });
  await Promise.resolve();
  assert.equal(attempts, 2);
  playback.close();
  assert.equal(speaker.srcObject, null);
});

test("requests the microphone before waiting for the agent lifecycle", async () => {
  const order = [];
  let resolveLifecycle;
  let stopped = 0;
  const microphone = {
    getAudioTracks: () => [],
    getTracks: () => [{ stop: () => { stopped += 1; } }],
  };
  const session = new BrowserVoiceSession({
    sessionId: "mobile-session",
    target: { pane: "main", branchId: 0 },
    voice: "cove",
    captureMicrophone() {
      order.push("microphone");
      return Promise.resolve(microphone);
    },
    workspace: async () => ({ root: "/workspace", list: async () => [] }),
    onStart() {
      order.push("lifecycle");
      return new Promise((resolve) => { resolveLifecycle = resolve; });
    },
    onStop: async () => {},
    onDelegation() {},
    onStatus() {},
    onTranscript() {},
  });

  const starting = session.start();
  assert.deepEqual(order, ["microphone", "lifecycle"]);
  session.abort();
  resolveLifecycle({ workspace: "/workspace", history: [] });
  await starting;
  assert.equal(stopped, 1);
});

test("builds bounded startup context from the main agent history and browser workspace", async () => {
  const context = await browserVoiceStartupContext({
    workspace: "/workspace",
    history: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "hidden" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "build voice mode" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "working on it" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "<realtime_conversation>skip</realtime_conversation>" }] },
    ],
  }, {
    root: "/workspace",
    async list(path) {
      return path === "."
        ? [
            { kind: "directory", path: "/workspace/src" },
            { kind: "directory", path: "/workspace/node_modules" },
            { kind: "file", path: "/workspace/README.md" },
          ]
        : path === "/workspace/src"
          ? [{ kind: "file", path: "/workspace/src/App.tsx" }]
          : [];
    },
  });
  assert.match(context ?? "", /build voice mode/);
  assert.match(context ?? "", /working on it/);
  assert.match(context ?? "", /src\/\n  - App\.tsx/);
  assert.doesNotMatch(context ?? "", /node_modules|<realtime_conversation>|hidden/);
  assert.ok(new TextEncoder().encode(context).byteLength <= 5_300 * 4);
});

test("bounds streamed backend output while preserving its head and tail", () => {
  const stream = new HandoffStream();
  stream.pushText(`HEAD-${"x".repeat(8_000)}-TAIL`);
  const head = stream.drainStreamChunk() ?? "";
  const tail = stream.drainFinalChunk() ?? "";
  const output = head + tail;
  assert.match(output, /^HEAD-/);
  assert.match(output, /…output truncated…/);
  assert.match(output, /-TAIL$/);
  assert.ok(new TextEncoder().encode(output).byteLength <= 4_000);
});
