import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_WORLD_RESIDENT_MEMORY,
  RESIDENT_IDS,
  WORLD_PROTOCOL,
  coordinationBasisFor,
  isWorldAgentCommand,
  isWorldAgentMessage,
  type WorldObservation,
} from "../src/monsterWorldProtocol.ts";

const observation = (agentId: "cinder" | "june"): WorldObservation => ({
  stateVersion: agentId === "cinder" ? 7 : 11,
  minuteOfDay: 480,
  weather: "clear",
  self: {
    id: agentId,
    name: agentId === "cinder" ? "Cinder" : "June",
    role: agentId === "cinder" ? "Rescue scout" : "Courier",
    kind: agentId === "cinder" ? "monster" : "human",
    scene: "town",
    x: agentId === "cinder" ? 16 : 18,
    y: 11,
    direction: "down",
    location: "Guild Plaza",
    energy: 80,
    curiosity: 75,
    social: 70,
  },
  nearby: [],
  roster: [],
  guildBoard: [],
  recentEvents: [],
  availableTargets: ["plaza", "bridge", "player"],
  supplies: {
    orchardBerries: 8,
    shopStock: 1,
    guildSupplies: 0,
    trainingMarks: 0,
  },
});

test("every resident is eligible for its own persistent Luna turn", () => {
  assert.equal(RESIDENT_IDS.length, 48);
  assert.equal(RESIDENT_IDS.includes("june"), true);
  assert.equal(RESIDENT_IDS.includes("guest24"), true);

  const cinder = {
    protocol: WORLD_PROTOCOL,
    type: "think",
    requestId: "cinder-7",
    agentId: "cinder",
    observation: observation("cinder"),
    memory: EMPTY_WORLD_RESIDENT_MEMORY,
  } as const;
  const june = { ...cinder, requestId: "june-11", agentId: "june", observation: observation("june") } as const;
  assert.equal(isWorldAgentCommand(cinder), true);
  assert.equal(isWorldAgentCommand(june), true);
  assert.equal(isWorldAgentCommand({ ...cinder, memory: undefined }), false);
});

test("resident settlements carry a typed failure reason", () => {
  assert.equal(isWorldAgentMessage({
    protocol: WORLD_PROTOCOL,
    type: "settled",
    requestId: "cinder-7",
    agentId: "cinder",
    outcome: "failed",
    failure: "transient",
    message: "temporary provider failure",
  }), true);
  assert.equal(isWorldAgentMessage({
    protocol: WORLD_PROTOCOL,
    type: "settled",
    requestId: "cinder-7",
    agentId: "cinder",
    outcome: "failed",
    failure: "made_up",
  }), false);
});

test("one resident action is correlated to its owning turn and fresh reducer result", () => {
  const action = {
    protocol: WORLD_PROTOCOL,
    type: "action",
    actionId: "cinder-action-1",
    requestId: "cinder-circle",
    agentId: "cinder",
    heardCallId: 12,
    action: { kind: "move_relative", anchor: "player", dx_pixels: 64, dy_pixels: 0 },
  } as const;
  assert.equal(isWorldAgentMessage(action), true);
  assert.equal(isWorldAgentMessage({ ...action, agentId: "june" }), true);
  assert.equal(isWorldAgentMessage({ ...action, action: { ...action.action, dx_pixels: 0 } }), false);
  assert.equal(isWorldAgentMessage({ ...action, action: { ...action.action, anchor: "nobody" } }), false);

  const current = observation("cinder");
  const result = {
    protocol: WORLD_PROTOCOL,
    type: "action_result",
    actionId: action.actionId,
    requestId: action.requestId,
    agentId: action.agentId,
    result: {
      worldRevision: current.stateVersion,
      outcome: { status: "in_progress", action: action.action, detail: "moving into position" },
      self: current.self,
      nearby: current.nearby,
      relevantEvents: ["Cinder moved east."],
    },
  } as const;
  assert.equal(isWorldAgentCommand(result), true);
  assert.equal(isWorldAgentCommand({ ...result, agentId: "june" }), false);
  assert.equal(isWorldAgentCommand({ ...result, result: { ...result.result, worldRevision: -1 } }), false);

  const roomResult = {
    protocol: WORLD_PROTOCOL,
    type: "room_send_result",
    sendId: "room-cinder-1",
    requestId: action.requestId,
    agentId: action.agentId,
    result: {
      status: "committed",
      message: {
        id: 8,
        fromId: "cinder",
        fromName: "Cinder",
        text: "North path is clear.",
        minuteOfDay: 481,
        origin: "nanocodex",
        scope: "public",
      },
    },
  } as const;
  assert.equal(isWorldAgentCommand(roomResult), true);
  assert.equal(isWorldAgentCommand({
    ...roomResult,
    result: { ...roomResult.result, message: { ...roomResult.result.message, fromId: "june" } },
  }), false);
});

test("stable co-listener ordering yields mirrored two-side slots", () => {
  const listeners = ["cinder", "moss", "rill", "luma", "iris", "rook"] as const;
  const bases = listeners.map((id) => coordinationBasisFor(listeners, id));

  assert.deepEqual(bases.map((basis) => basis?.twoSides), [
    { side: "left", dxPixels: -64, dyPixels: -32 },
    { side: "left", dxPixels: -64, dyPixels: 0 },
    { side: "left", dxPixels: -64, dyPixels: 32 },
    { side: "right", dxPixels: 64, dyPixels: -32 },
    { side: "right", dxPixels: 64, dyPixels: 0 },
    { side: "right", dxPixels: 64, dyPixels: 32 },
  ]);
  assert.deepEqual(coordinationBasisFor(listeners, "cinder"), bases[0]);
  assert.equal(coordinationBasisFor(listeners, "june"), undefined);
});

test("runtime action messages reject malformed physical actions", () => {
  const action = {
    protocol: WORLD_PROTOCOL,
    type: "action",
    actionId: "cinder-action",
    requestId: "cinder-turn",
    agentId: "cinder",
    action: { kind: "say", text: "On my way!" },
  } as const;
  assert.equal(isWorldAgentMessage(action), true);
  assert.equal(isWorldAgentMessage({ ...action, actionId: "" }), false);
  assert.equal(isWorldAgentMessage({ ...action, action: { kind: "say", text: "" } }), false);
  const roomSend = {
    protocol: WORLD_PROTOCOL,
    type: "room_send",
    sendId: "room-cinder-1",
    requestId: "cinder-turn",
    agentId: "cinder",
    text: "I will cover the north path.",
  } as const;
  assert.equal(isWorldAgentMessage(roomSend), true);
  assert.equal(isWorldAgentMessage({ ...roomSend, text: "" }), false);
  assert.equal(isWorldAgentMessage({ ...action, action: { kind: "wait", duration_ms: 9_000 } }), false);
});

test("cancel selectors are real bounded arrays of nonempty unique ids", () => {
  assert.equal(isWorldAgentCommand({ protocol: WORLD_PROTOCOL, type: "cancel" }), true);
  assert.equal(isWorldAgentCommand({
    protocol: WORLD_PROTOCOL,
    type: "cancel",
    agentIds: ["cinder"],
    requestIds: ["cinder-7"],
  }), true);

  const sparseIds = new Array<string>(1);
  const invalidSelectors: readonly Record<string, unknown>[] = [
    { agentIds: "cinder" },
    { requestIds: null },
    { agentIds: [] },
    { requestIds: ["same", "same"] },
    { requestIds: sparseIds },
    { requestIds: Array.from({ length: RESIDENT_IDS.length + 1 }, (_, index) => `request-${index}`) },
  ];
  for (const selectors of invalidSelectors) {
    assert.equal(isWorldAgentCommand({
      protocol: WORLD_PROTOCOL,
      type: "cancel",
      ...selectors,
    }), false, JSON.stringify(selectors));
  }
});

test("resident turns deeply reject malformed observations", () => {
  const valid = detailedObservation();
  const accepts = (candidate: unknown) => isWorldAgentCommand({
    protocol: WORLD_PROTOCOL,
    type: "think",
    requestId: "cinder-observation",
    agentId: "cinder",
    observation: candidate,
    memory: EMPTY_WORLD_RESIDENT_MEMORY,
  });
  assert.equal(accepts(valid), true);

  const nearby = valid.nearby[0];
  const roster = valid.roster[0];
  const board = valid.guildBoard[0];
  assert.ok(nearby && roster && board && valid.guildCall);
  const sparseRoster = new Array<unknown>(2);
  sparseRoster[0] = roster;
  const malformed: readonly unknown[] = [
    { ...valid, stateVersion: -1 },
    { ...valid, minuteOfDay: 24 * 60 },
    { ...valid, weather: "hail" },
    { ...valid, self: { ...valid.self, kind: "player" } },
    { ...valid, self: { ...valid.self, energy: Number.NaN } },
    { ...valid, nearby: [{ ...nearby, distance: -1 }] },
    { ...valid, roster: [{ ...roster, activity: 12 }] },
    { ...valid, roster: sparseRoster },
    { ...valid, playerOrder: { id: 4, text: "", requestedTarget: "plaza" } },
    { ...valid, playerOrder: { id: 4, text: "Go", requestedTarget: "nowhere" } },
    { ...valid, guildCall: { ...valid.guildCall, requestedTarget: "nowhere" } },
    { ...valid, guildCall: { ...valid.guildCall, coListeners: [] } },
    { ...valid, guildCall: { ...valid.guildCall, coListeners: ["cinder", "cinder"] } },
    { ...valid, guildBoard: [{ ...board, fromName: 9 }] },
    { ...valid, recentEvents: ["Bell rang", 7] },
    { ...valid, availableTargets: ["plaza", "nowhere"] },
    { ...valid, supplies: { ...valid.supplies, shopStock: -1 } },
    { ...valid, supplies: Object.assign([], valid.supplies) },
  ];
  for (const candidate of malformed) assert.equal(accepts(candidate), false);
});

function detailedObservation(): WorldObservation {
  return {
    ...observation("cinder"),
    nearby: [{
      id: "player",
      name: "Scout",
      kind: "player",
      scene: "town",
      x: 16,
      y: 13,
      relativeX: 0,
      relativeY: 2,
      distance: 2.5,
      direction: "up",
      activity: "checking the board",
    }],
    roster: [{
      id: "cinder",
      name: "Cinder",
      kind: "monster",
      scene: "town",
      x: 16,
      y: 11,
      direction: "down",
      location: "Guild Plaza",
      activity: "waiting",
    }],
    guildCall: {
      id: 12,
      text: "Check Bell Bridge",
      voice: "call",
      distance: 2.5,
      radius: 12,
      guildWide: false,
      coListeners: ["cinder", "june"],
      requestedTarget: "bridge",
    },
    guildBoard: [{
      id: 4,
      fromId: "player",
      fromName: "Scout",
      toId: "cinder",
      toName: "Cinder",
      text: "Check Bell Bridge",
      minuteOfDay: 479,
      origin: "player",
      scope: "spatial",
    }],
    recentEvents: ["Scout called from the plaza"],
  };
}
