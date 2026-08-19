import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHATGPT_VOICES,
  HandoffStream,
  parseVoiceArgument,
  preferredPhysicalInput,
} from "../src/browserVoice.ts";
import {
  browserVoiceStartupContext,
  realtimeDelegation,
  realtimeTailDelegation,
} from "../src/voiceProtocol.ts";

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
  ] as MediaDeviceInfo[];
  assert.equal(
    preferredPhysicalInput(devices, "BlackHole 2ch (Virtual)")?.deviceId,
    "built-in",
  );
  assert.equal(preferredPhysicalInput(devices, "USB microphone"), undefined);
});

test("uses the Rust delegation and transcript-tail markers", () => {
  assert.equal(
    realtimeDelegation("fix <x> & ship", [
      { role: "assistant", text: "Use <main>" },
      { role: "user", text: "yes & now" },
    ]),
    "<realtime_delegation>\n  <input>fix &lt;x&gt; &amp; ship</input>\n  <transcript_delta>assistant: Use &lt;main&gt;\nuser: yes &amp; now</transcript_delta>\n</realtime_delegation>",
  );
  const tail = realtimeTailDelegation([{ role: "user", text: "finish this" }]);
  assert.match(tail ?? "", /<source>transcript_tail_flush<\/source>/);
  assert.match(tail ?? "", /user: finish this/);
  assert.equal(realtimeTailDelegation([]), undefined);
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
  } as any);
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
