import assert from "node:assert/strict";
import test from "node:test";
import { justBash } from "nanocodex/tools/bash";

import type { WorldBoardMessage } from "../src/monsterWorldProtocol.ts";
import {
  createWorldRoomWorkspace,
  formatWorldRoomMessages,
} from "../src/monsterWorldRoomWorkspace.ts";

const messages: WorldBoardMessage[] = [
  {
    id: 2,
    fromId: "moss",
    fromName: "Moss",
    text: "I will cover the west path.",
    minuteOfDay: 493,
    origin: "nanocodex",
    scope: "public",
  },
  {
    id: 1,
    fromId: "cinder",
    fromName: "Cinder",
    text: "I will cover the north path.",
    minuteOfDay: 492,
    origin: "nanocodex",
    scope: "public",
  },
];

test("the room transcript is chronological JSONL that normal shell filters can inspect", () => {
  const lines = formatWorldRoomMessages(messages).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map(({ seq }) => seq), [1, 2]);
  assert.deepEqual(lines.map(({ from }) => from), ["Cinder", "Moss"]);
  assert.equal(lines[1]?.text, "I will cover the west path.");
});

test("the shared workspace exposes a dynamic read-only transcript and authenticated send file", async () => {
  const sent: string[] = [];
  const workspace = createWorldRoomWorkspace({
    messages: () => messages,
    async send(text) {
      sent.push(text);
    },
  });

  assert.deepEqual(
    (await workspace.list(".", { recursive: true })).map(({ path }) => path),
    [
      "/workspace/world",
      "/workspace/world/room",
      "/workspace/world/room/README.md",
      "/workspace/world/room/messages.jsonl",
      "/workspace/world/room/send",
    ],
  );
  const transcript = new TextDecoder().decode(
    await workspace.readFile("/workspace/world/room/messages.jsonl"),
  );
  assert.match(transcript, /"from":"Cinder"/);
  assert.match(transcript, /"from":"Moss"/);

  await workspace.writeFile("world/room/send", "  Meet at the bridge.\n");
  assert.deepEqual(sent, ["Meet at the bridge."]);
  await assert.rejects(
    workspace.writeFile("world/room/messages.jsonl", "forged"),
    /read-only/,
  );
  await assert.rejects(workspace.remove("world/room/send"), /cannot be removed/);
  await assert.rejects(workspace.writeFile("world/room/send", "x".repeat(1_025)), /1024 bytes/);
});

test("an actual Bash write receives its reducer receipt before the next transcript read", async () => {
  const liveMessages = [...messages];
  const workspace = createWorldRoomWorkspace({
    messages: () => liveMessages,
    async send(text) {
      liveMessages.push({
        id: 3,
        fromId: "rill",
        fromName: "Rill",
        text,
        minuteOfDay: 494,
        origin: "nanocodex",
        scope: "public",
      });
    },
  });
  const shell = await justBash({
    filesystem: workspace,
    executionTimeoutMs: 1_000,
    maxEntries: 16,
    maxOutputTokens: 256,
    network: false,
  });
  const result = await shell.tool.handler({
    cmd: "printf '%s' 'Rill claims east.' > world/room/send && tail -n 1 world/room/messages.jsonl",
  }, {
    callId: "room-call",
    parentCallId: "room-turn",
    sessionId: "room-session",
    signal: new AbortController().signal,
  });
  assert.equal(typeof result, "object");
  assert.match((result as { output: string }).output, /"from":"Rill"/);
  assert.match((result as { output: string }).output, /"text":"Rill claims east\."/);
});
