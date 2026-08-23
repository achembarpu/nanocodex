import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTONOMOUS_AGENT_IDS,
  EMPTY_WORLD_RESIDENT_MEMORY,
  WORLD_PROTOCOL,
  coordinationBasisFor,
  decodeResidentDecision,
  decodeStagedBatch,
  isWorldAgentCommand,
  isWorldAgentMessage,
  isWorldPlan,
  isWorldUsageLimitMessage,
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

test("every resident is eligible for bounded autonomous Luna batches", () => {
  assert.equal(AUTONOMOUS_AGENT_IDS.length, 48);
  assert.equal(AUTONOMOUS_AGENT_IDS.includes("june"), true);
  assert.equal(AUTONOMOUS_AGENT_IDS.includes("guest24"), true);

  const command = {
    protocol: WORLD_PROTOCOL,
    type: "think_batch",
    batchId: "batch-1",
    entries: [
      { requestId: "cinder-7", agentId: "cinder", observation: observation("cinder"), memory: EMPTY_WORLD_RESIDENT_MEMORY },
      { requestId: "june-11", agentId: "june", observation: observation("june"), memory: EMPTY_WORLD_RESIDENT_MEMORY },
    ],
  } as const;
  assert.equal(isWorldAgentCommand(command), true);
  assert.equal(isWorldAgentCommand({
    ...command,
    entries: [...command.entries, command.entries[0]],
  }), false);
});

test("staged batches require exactly one versioned plan and bounded memory per resident", () => {
  const decisions = decodeStagedBatch({
    batch_id: "batch-1",
    decisions: [
      {
        plan: {
          request_id: "cinder-7",
          agent_id: "cinder",
          state_version: 7,
          summary: "checks Bell Bridge",
          steps: [{ kind: "move", target: "bridge" }],
        },
        memory: {
          summary: "Scout asked me to inspect Bell Bridge.",
          goals: ["Reach Bell Bridge"],
          relationships: ["June is carrying the guild post"],
          recent_decisions: ["Accepted Scout's bridge order"],
          last_board_message_id: 12,
        },
      },
      {
        plan: {
          request_id: "june-11",
          agent_id: "june",
          state_version: 11,
          summary: "delivers the guild post",
          steps: [{ kind: "move", target: "plaza" }],
        },
        memory: {
          summary: "I have a fresh guild post for the plaza.",
          goals: ["Deliver the post"],
          relationships: [],
          recent_decisions: ["Chose the plaza route"],
          last_board_message_id: 12,
        },
      },
    ],
  }, {
    batchId: "batch-1",
    entries: [
      { requestId: "cinder-7", agentId: "cinder", stateVersion: 7 },
      { requestId: "june-11", agentId: "june", stateVersion: 11 },
    ],
  });

  assert.deepEqual(decisions.map(({ plan }) => plan.agentId), ["cinder", "june"]);
  assert.equal(decisions[0]?.memory.lastBoardMessageId, 12);
  assert.ok(Object.isFrozen(decisions));
  assert.equal(isWorldAgentMessage({
    protocol: WORLD_PROTOCOL,
    type: "batch_result",
    batchId: "batch-1",
    decisions,
    usage: { modelTurns: 2, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  }), true);

  assert.throws(() => decodeStagedBatch({
    batch_id: "batch-1",
    decisions: [{
      plan: {
        request_id: "cinder-7",
        agent_id: "cinder",
        state_version: 7,
        summary: "duplicates one resident",
        steps: [{ kind: "move", target: "bridge" }],
      },
      memory: {},
    }],
  }, {
    batchId: "batch-1",
    entries: [
      { requestId: "cinder-7", agentId: "cinder", stateVersion: 7 },
      { requestId: "june-11", agentId: "june", stateVersion: 11 },
    ],
  }), /exactly one entry/);
});

test("batch settlements carry a typed breaker reason", () => {
  assert.equal(isWorldAgentMessage({
    protocol: WORLD_PROTOCOL,
    type: "batch_settled",
    batchId: "batch-1",
    requestIds: ["cinder-7", "june-11"],
    agentIds: ["cinder", "june"],
    outcome: "failed",
    failure: "usage_limit",
    message: "usage limit reached",
  }), true);
  assert.equal(isWorldAgentMessage({
    protocol: WORLD_PROTOCOL,
    type: "batch_settled",
    batchId: "batch-1",
    requestIds: ["cinder-7"],
    agentIds: ["cinder"],
    outcome: "failed",
    failure: "made_up",
  }), false);
});

test("one resident decision is bound to its session identity and advances only its memory", () => {
  const previous = Object.freeze({
    summary: "Cinder keeps watch at Bell Bridge.",
    goals: Object.freeze(["Protect the bridge"]),
    relationships: Object.freeze(["June carries guild dispatches"]),
    recentDecisions: Object.freeze(["Waited by the bridge"]),
    lastBoardMessageId: 12,
  });
  const decision = decodeResidentDecision({
    summary: "takes the eastern circle slot",
    steps: [{ kind: "move_relative", anchor: "player", dx_pixels: 64, dy_pixels: 0 }],
    memory_note: "Scout asked the group to hold a circle.",
  }, {
    requestId: "cinder-circle",
    agentId: "cinder",
    stateVersion: 7,
    memory: previous,
  });

  assert.equal(decision.plan.requestId, "cinder-circle");
  assert.equal(decision.plan.agentId, "cinder");
  assert.deepEqual(decision.memory.goals, previous.goals);
  assert.deepEqual(decision.memory.relationships, previous.relationships);
  assert.deepEqual(decision.memory.recentDecisions, [
    "Scout asked the group to hold a circle.",
    "Waited by the bridge",
  ]);
  const spoofed = decodeResidentDecision({
    summary: "impersonates June",
    steps: [{ kind: "move", target: "plaza" }],
    agent_id: "june",
  }, {
    requestId: "cinder-circle",
    agentId: "cinder",
    stateVersion: 7,
  });
  assert.equal(spoofed.plan.agentId, "cinder");
  assert.equal(spoofed.plan.requestId, "cinder-circle");
});

test("stable co-listener ordering yields unique circle and mirrored two-side slots", () => {
  const listeners = ["cinder", "moss", "rill", "luma", "iris", "rook"] as const;
  const bases = listeners.map((id) => coordinationBasisFor(listeners, id));

  assert.deepEqual(bases.map((basis) => basis?.radial), [
    { dxPixels: 64, dyPixels: 0 },
    { dxPixels: 32, dyPixels: 56 },
    { dxPixels: -32, dyPixels: 56 },
    { dxPixels: -64, dyPixels: 0 },
    { dxPixels: -32, dyPixels: -56 },
    { dxPixels: 32, dyPixels: -56 },
  ]);
  assert.deepEqual(bases.map((basis) => basis?.twoSides), [
    { side: "left", dxPixels: -64, dyPixels: -32 },
    { side: "left", dxPixels: -64, dyPixels: 0 },
    { side: "left", dxPixels: -64, dyPixels: 32 },
    { side: "right", dxPixels: 64, dyPixels: -32 },
    { side: "right", dxPixels: 64, dyPixels: 0 },
    { side: "right", dxPixels: 64, dyPixels: 32 },
  ]);
  assert.equal(new Set(bases.map((basis) => JSON.stringify(basis?.radial))).size, listeners.length);
  assert.deepEqual(coordinationBasisFor(listeners, "cinder"), bases[0]);
  assert.equal(coordinationBasisFor(listeners, "june"), undefined);
});

test("runtime plan and batch guards reject sparse and duplicate decisions", () => {
  const cinder = runtimeDecision("cinder", "cinder-7", 7);
  const june = runtimeDecision("june", "june-11", 11);
  const sparseSteps = new Array<unknown>(2);
  sparseSteps[0] = { kind: "move", target: "bridge" };
  assert.equal(isWorldPlan({ ...cinder.plan, steps: sparseSteps }), false);

  const sparseDecisions = new Array<unknown>(2);
  sparseDecisions[0] = cinder;
  assert.equal(isWorldAgentMessage(batchResult(sparseDecisions)), false);
  assert.equal(isWorldAgentMessage(batchResult([
    cinder,
    runtimeDecision("june", "cinder-7", 11),
  ])), false, "duplicate request ids");
  assert.equal(isWorldAgentMessage(batchResult([
    cinder,
    runtimeDecision("cinder", "cinder-8", 8),
  ])), false, "duplicate residents");
  assert.equal(isWorldAgentMessage(batchResult([cinder, june])), true);
  assert.equal(isWorldAgentMessage({
    ...batchResult([cinder]),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  }), false, "resident-turn accounting is required");
  assert.equal(isWorldAgentMessage({
    ...batchResult([cinder]),
    usage: { modelTurns: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  }), false, "resident-turn accounting must be positive");
});

test("cancel selectors are real bounded arrays of nonempty unique ids", () => {
  assert.equal(isWorldAgentCommand({ protocol: WORLD_PROTOCOL, type: "cancel" }), true);
  assert.equal(isWorldAgentCommand({
    protocol: WORLD_PROTOCOL,
    type: "cancel",
    agentIds: ["cinder"],
    batchIds: ["batch-1"],
    requestIds: ["cinder-7"],
  }), true);

  const sparseIds = new Array<string>(1);
  const invalidSelectors: readonly Record<string, unknown>[] = [
    { agentIds: "cinder" },
    { batchIds: { every: () => true } },
    { requestIds: null },
    { agentIds: [] },
    { batchIds: ["   "] },
    { requestIds: ["same", "same"] },
    { batchIds: ["x".repeat(97)] },
    { requestIds: sparseIds },
    { requestIds: Array.from({ length: AUTONOMOUS_AGENT_IDS.length + 1 }, (_, index) => `request-${index}`) },
  ];
  for (const selectors of invalidSelectors) {
    assert.equal(isWorldAgentCommand({
      protocol: WORLD_PROTOCOL,
      type: "cancel",
      ...selectors,
    }), false, JSON.stringify(selectors));
  }
});

test("think batches deeply reject malformed observations", () => {
  const valid = detailedObservation();
  const accepts = (candidate: unknown) => isWorldAgentCommand({
    protocol: WORLD_PROTOCOL,
    type: "think_batch",
    batchId: "batch-observation",
    entries: [{
      requestId: "cinder-observation",
      agentId: "cinder",
      observation: candidate,
      memory: EMPTY_WORLD_RESIDENT_MEMORY,
    }],
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

test("usage-limit classification recognizes shared API error spellings", () => {
  for (const message of [
    "usage_limit_reached",
    "Usage limit has been reached",
    "RATE LIMIT exceeded",
    "HTTP 429: too many requests",
  ]) assert.equal(isWorldUsageLimitMessage(message), true, message);
  for (const message of ["temporary transport error", "error 1429", "4290 requests queued"]) {
    assert.equal(isWorldUsageLimitMessage(message), false, message);
  }
});

function runtimeDecision(
  agentId: "cinder" | "june",
  requestId: string,
  stateVersion: number,
) {
  return {
    plan: {
      protocol: WORLD_PROTOCOL,
      requestId,
      agentId,
      stateVersion,
      summary: "checks the town",
      steps: [{ kind: "move", target: "plaza" }],
      origin: "nanocodex",
    },
    memory: EMPTY_WORLD_RESIDENT_MEMORY,
  } as const;
}

function batchResult(decisions: unknown) {
  return {
    protocol: WORLD_PROTOCOL,
    type: "batch_result",
    batchId: "batch-malicious",
    decisions,
    usage: { modelTurns: 2, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as const;
}

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
