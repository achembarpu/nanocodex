import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHATGPT_VOICES,
  parseVoiceArgument,
  preferredPhysicalInput,
} from "../src/browserVoice.ts";

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
