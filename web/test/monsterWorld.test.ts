import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GUEST_AGENT_IDS,
  LIVE_AGENT_IDS,
  RESIDENT_IDS,
  VOICE_RADIUS,
  WORLD_PROTOCOL,
  decodeStagedPlan,
  isWorldAgentMessage,
} from "../src/monsterWorldProtocol.ts";
import {
  BASE_RESIDENT_COUNT,
  MAX_RESIDENT_COUNT,
  activeResidentCount,
  actorWorldPosition,
  applyWorldPlan,
  createWorldState,
  hasUnansweredGuildCall,
  hasUnansweredPlayerOrder,
  isGuildRelayActive,
  movePlayer,
  observationFor,
  playerSpeak,
  requestResidentExit,
  residentAtWorldPoint,
  serializeWorldState,
  setPopulationTarget,
  updateWorld,
} from "../src/monsterWorldSimulation.ts";

const component = source("../src/MonsterWorld.tsx");
const worldCss = source("../src/MonsterWorld.css");
const worker = source("../src/monsterWorldAgent.worker.ts");
const application = source("../src/NanocodexApp.tsx");
const routeLoaders = source("../src/routeLoaders.ts");
const attribution = source("../public/world/ATTRIBUTION.md");

test("world plans are bounded, versioned, and normalized before entering the simulation", () => {
  const expected = { requestId: "turn-1", agentId: "moss", stateVersion: 7 } as const;
  const plan = decodeStagedPlan({
    request_id: "turn-1",
    agent_id: "moss",
    state_version: 7,
    summary: "checks the bridge for silver dust",
    steps: [
      { kind: "move", target: "bridge" },
      { kind: "say", text: "  The current changed.\nLook east!  ", to: "rill" },
      { kind: "interact", target: "bridge", action: "inspect" },
    ],
  }, expected);

  assert.equal(plan.protocol, WORLD_PROTOCOL);
  assert.equal(plan.origin, "nanocodex");
  assert.equal(plan.steps[1]?.kind === "say" && plan.steps[1].text, "The current changed. Look east!");
  assert.ok(Object.isFrozen(plan));
  assert.throws(
    () => decodeStagedPlan({
      request_id: "turn-1",
      agent_id: "moss",
      state_version: 6,
      summary: "stale",
      steps: [{ kind: "move", target: "bridge" }],
    }, expected),
    /state_version is stale/,
  );
  assert.throws(
    () => decodeStagedPlan({
      request_id: "turn-1",
      agent_id: "moss",
      state_version: 7,
      summary: "escapes the map",
      steps: [{ kind: "move", target: "internet" }],
    }, expected),
    /not an allowed value/,
  );
  assert.throws(
    () => decodeStagedPlan({
      request_id: "turn-1",
      agent_id: "moss",
      state_version: 7,
      summary: "ignores Scout's destination",
      steps: [{ kind: "move", target: "bridge" }],
    }, { ...expected, requestedTarget: "player" }),
    /must physically act at player/,
  );
  assert.throws(
    () => decodeStagedPlan({
      request_id: "turn-1",
      agent_id: "moss",
      state_version: 7,
      summary: "pretends to move",
      steps: [{ kind: "move_relative", anchor: "player", dx_pixels: 0, dy_pixels: 0 }],
    }, expected),
    /must change at least one axis/,
  );
  assert.throws(
    () => decodeStagedPlan({
      request_id: "turn-1",
      agent_id: "moss",
      state_version: 7,
      summary: "returns an empty random branch",
      steps: [{
        kind: "random_choice",
        chance_percent: 50,
        true_label: "heads",
        false_label: "tails",
        if_true: [],
        if_false: [{ kind: "wait", duration_ms: 300 }],
      }],
    }, expected),
    /must contain 1-3 physical actions/,
  );
});

test("the reducer owns movement, mission effects, stale rejection, and idempotency", () => {
  const state = createWorldState();
  const observation = observationFor(state, "moss");
  const plan = decodeStagedPlan({
    request_id: "moss-1",
    agent_id: "moss",
    state_version: observation.stateVersion,
    summary: "follows silver dust into the orchard",
    steps: [
      { kind: "move", target: "orchard" },
      { kind: "interact", target: "orchard", action: "gather" },
      { kind: "emote", icon: "spark" },
    ],
  }, {
    requestId: "moss-1",
    agentId: "moss",
    stateVersion: observation.stateVersion,
  });

  assert.deepEqual(applyWorldPlan(state, plan), { accepted: true });
  assert.deepEqual(applyWorldPlan(state, plan), { accepted: false, reason: "duplicate" });
  const stale = decodeStagedPlan({
    request_id: "moss-2",
    agent_id: "moss",
    state_version: observation.stateVersion,
    summary: "repeats an old thought",
    steps: [{ kind: "wait", duration_ms: 300 }],
  }, {
    requestId: "moss-2",
    agentId: "moss",
    stateVersion: observation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(state, stale), { accepted: false, reason: "stale" });

  for (let index = 0; index < 1_000 && state.mission.stage < 1; index += 1) {
    updateWorld(state, 100);
  }
  assert.ok(state.mission.stage >= 1);
  assert.doesNotMatch(state.mission.title, /bell beneath the water/i);
  assert.ok(state.activities.some(({ origin, text }) =>
    origin === "nanocodex" && /Moss decided/.test(text)
  ));
  assert.ok(state.activities.some(({ text }) => /silver dust/i.test(text)));

  const before = { x: state.actors.player.x, y: state.actors.player.y };
  assert.equal(movePlayer(state, "left"), true);
  updateWorld(state, 100);
  updateWorld(state, 100);
  assert.deepEqual(
    { x: state.actors.player.x, y: state.actors.player.y },
    { x: before.x - 1, y: before.y },
  );
  assert.equal(JSON.parse(serializeWorldState(state)).version, 3);
});

test("voice is spatial off-center and guild-wide at the central relay", () => {
  const relay = createWorldState();
  assert.equal(Object.keys(relay.actors).length, RESIDENT_IDS.length + 1);
  assert.equal(LIVE_AGENT_IDS.length, 6);
  assert.equal(RESIDENT_IDS.length, 48);
  assert.equal(BASE_RESIDENT_COUNT, 24);
  assert.equal(MAX_RESIDENT_COUNT, 48);
  assert.equal(activeResidentCount(relay), BASE_RESIDENT_COUNT);
  assert.equal(isGuildRelayActive(relay), true);
  const activeIds = RESIDENT_IDS.slice(0, BASE_RESIDENT_COUNT);
  const before = Object.fromEntries(activeIds.map((id) => [id, relay.decisionVersions[id]]));
  const broadcast = playerSpeak(relay, "Everyone meet at the bridge.", "whisper");
  assert.ok(broadcast);
  assert.equal(broadcast.guildWide, true);
  assert.equal(broadcast.heardBy.length, BASE_RESIDENT_COUNT);
  assert.deepEqual(broadcast.liveHeardBy, activeIds);
  for (const id of activeIds) {
    assert.equal(relay.decisionVersions[id], (before[id] ?? 0) + 1);
    const observation = observationFor(relay, id);
    assert.equal(observation.playerOrder?.text, "Everyone meet at the bridge.");
    assert.equal(observation.guildCall?.text, "Everyone meet at the bridge.");
    assert.equal(observation.guildBoard[0]?.text, "Everyone meet at the bridge.");
    assert.equal(relay.actors[id].listenerPulse?.callId, broadcast.callId);
    assert.equal(hasUnansweredGuildCall(relay, id), true);
  }

  const local = createWorldState();
  local.actors.player.x = 1;
  local.actors.player.y = 22;
  local.actors.cinder.x = 2;
  local.actors.cinder.y = 22;
  assert.equal(isGuildRelayActive(local), false);
  const mossVersion = local.decisionVersions.moss;
  const whisper = playerSpeak(local, "Cinder, stay close.", "whisper");
  assert.ok(whisper);
  assert.equal(whisper.guildWide, false);
  assert.equal(whisper.radius, VOICE_RADIUS.whisper);
  assert.deepEqual(whisper.liveHeardBy, ["cinder"]);
  const distant = observationFor(local, "moss");
  assert.equal(distant.playerOrder?.text, "Cinder, stay close.");
  assert.equal(distant.guildCall, undefined);
  assert.equal(distant.guildBoard.some(({ text }) => text === "Cinder, stay close."), true);
  assert.equal(distant.recentEvents.some((text) => text.includes("Cinder, stay close.")), false);
  assert.equal(local.actors.cinder.listenerPulse?.callId, whisper.callId);
  assert.equal(local.decisionVersions.moss, mossVersion + 1);
});

test("a reducer-owned Scout order blocks model overwrite until physical completion", () => {
  const state = createWorldState();
  const staleObservation = observationFor(state, "cinder");
  const speech = playerSpeak(state, "Cinder, inspect the gate.", "call");
  assert.ok(speech);
  assert.equal(observationFor(state, "cinder").guildCall?.id, speech.callId);

  const stale = decodeStagedPlan({
    request_id: "old-cinder",
    agent_id: "cinder",
    state_version: staleObservation.stateVersion,
    summary: "continues an old patrol",
    steps: [{ kind: "wait", duration_ms: 300 }],
  }, {
    requestId: "old-cinder",
    agentId: "cinder",
    stateVersion: staleObservation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(state, stale), { accepted: false, reason: "stale" });
  assert.equal(hasUnansweredGuildCall(state, "cinder"), true);

  const activeObservation = observationFor(state, "cinder");

  const premature = decodeStagedPlan({
    request_id: "premature-call-cinder",
    agent_id: "cinder",
    state_version: activeObservation.stateVersion,
    summary: "answers Scout and checks the gate",
    steps: [{ kind: "say", text: "On it!" }, { kind: "move", target: "dungeon_gate" }],
  }, {
    requestId: "premature-call-cinder",
    agentId: "cinder",
    stateVersion: activeObservation.stateVersion,
    heardCallId: activeObservation.guildCall?.id,
    requestedTarget: activeObservation.guildCall?.requestedTarget,
  });
  assert.deepEqual(applyWorldPlan(state, premature), { accepted: false, reason: "stale" });
  advanceOrderToTerminal(state, speech.order?.id);

  const completedObservation = observationFor(state, "cinder");
  const response = decodeStagedPlan({
    request_id: "call-cinder",
    agent_id: "cinder",
    state_version: completedObservation.stateVersion,
    summary: "reports the completed gate assignment",
    steps: [{ kind: "say", text: "At the gate, Scout!" }, { kind: "move", target: "dungeon_gate" }],
  }, {
    requestId: "call-cinder",
    agentId: "cinder",
    stateVersion: completedObservation.stateVersion,
    heardCallId: completedObservation.guildCall?.id,
    requestedTarget: completedObservation.guildCall?.requestedTarget,
  });
  assert.deepEqual(applyWorldPlan(state, response), { accepted: true });
  assert.equal(hasUnansweredGuildCall(state, "cinder"), false);
  assert.equal(observationFor(state, "cinder").guildCall, undefined);
});

test("exact gather and split orders physically complete offline for every active resident", () => {
  const state = createWorldState();
  const gather = playerSpeak(state, "Everyone come to me.", "whisper");
  assert.ok(gather);
  assert.ok(gather.order);
  assert.equal(state.agentsOnline, false);
  assert.equal(gather.order.assigned.length, BASE_RESIDENT_COUNT);
  assert.equal(gather.order.rejected.length, 0);
  const activeIds = RESIDENT_IDS.slice(0, BASE_RESIDENT_COUNT);
  assert.deepEqual(gather.liveAddressed, activeIds);
  assert.ok(orderById(state, gather.order.id).assignments.every(({ status }) => status === "assigned"));
  for (const id of activeIds) {
    const observation = observationFor(state, id);
    assert.equal(observation.roster.length, BASE_RESIDENT_COUNT + 1);
    assert.equal(observation.roster.some(({ id: actorId }) => actorId === "player"), true);
    assert.equal(observation.guildBoard[0]?.text, "Everyone come to me.");
    assert.equal(observation.guildCall?.requestedTarget, "player");
  }
  updateWorld(state, 100);
  const gatherOrder = orderById(state, gather.order.id);
  assert.ok(gatherOrder.assignments.some(({ status }) => status === "moving"));
  advanceOrderToTerminal(state, gather.order.id);
  assertOrderCompletedAtGoals(state, gather.order.id);

  const split = createWorldState();
  const command = playerSpeak(
    split,
    "Cinder, Moss, and Rill go to the bridge; everyone else go to the pond.",
    "talk",
  );
  assert.ok(command);
  assert.ok(command.order);
  assert.equal(command.order.assigned.length, BASE_RESIDENT_COUNT);
  assert.equal(command.order.rejected.length, 0);
  assert.deepEqual(command.liveAddressed, activeIds);
  for (const id of ["cinder", "moss", "rill"] as const) {
    assert.equal(observationFor(split, id).guildCall?.requestedTarget, "bridge");
  }
  for (const id of ["luma", "iris", "rook"] as const) {
    assert.equal(observationFor(split, id).guildCall?.requestedTarget, "pond");
  }
  const splitOrder = orderById(split, command.order.id);
  for (const assignment of splitOrder.assignments) {
    const expected = (["cinder", "moss", "rill"] as readonly string[]).includes(assignment.actorId)
      ? "bridge"
      : "pond";
    assert.equal(assignment.target, expected, assignment.actorId);
  }
  advanceOrderToTerminal(split, command.order.id);
  assertOrderCompletedAtGoals(split, command.order.id);
});

test("a recognized order preempts old tasks and an in-flight tile before moving", () => {
  const state = createWorldState();
  const observation = observationFor(state, "cinder");
  const oldPlan = decodeStagedPlan({
    request_id: "old-bridge-patrol",
    agent_id: "cinder",
    state_version: observation.stateVersion,
    summary: "continues an old bridge patrol",
    steps: [{ kind: "move", target: "bridge" }],
  }, {
    requestId: "old-bridge-patrol",
    agentId: "cinder",
    stateVersion: observation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(state, oldPlan), { accepted: true });
  updateWorld(state, 100);
  assert.ok(state.actors.cinder.movement);
  const versions = Object.fromEntries(LIVE_AGENT_IDS.map((id) => [id, state.decisionVersions[id]]));

  const speech = playerSpeak(state, "Everyone come to me", "call");
  assert.ok(speech?.order);
  assert.equal(state.actors.cinder.movement, undefined);
  assert.equal(state.actors.cinder.tasks.length, 1);
  assert.equal(state.actors.cinder.tasks[0]?.orderId, speech.order.id);
  assert.equal(state.actors.cinder.tasks[0]?.requestId.includes("old-bridge-patrol"), false);
  assert.equal(
    state.actors.cinder.tasks[0]?.action.kind === "move" && state.actors.cinder.tasks[0].action.target,
    "player",
  );
  for (const id of LIVE_AGENT_IDS) {
    assert.equal(state.decisionVersions[id], (versions[id] ?? 0) + 1, id);
  }
});

test("a newer order preempts unfinished assignments and fences a late model result", () => {
  const state = createWorldState();
  const gather = playerSpeak(state, "Everyone come to me", "call");
  assert.ok(gather?.order);
  updateWorld(state, 100);
  const oldObservation = observationFor(state, "cinder");
  const latePlan = decodeStagedPlan({
    request_id: "late-gather-response",
    agent_id: "cinder",
    state_version: oldObservation.stateVersion,
    summary: "continues the superseded gather",
    steps: [{ kind: "move", target: "player" }],
  }, {
    requestId: "late-gather-response",
    agentId: "cinder",
    stateVersion: oldObservation.stateVersion,
    heardCallId: oldObservation.guildCall?.id,
    requestedTarget: oldObservation.guildCall?.requestedTarget,
  });

  const split = playerSpeak(
    state,
    "Cinder, Moss, and Rill go to the bridge; everyone else go to the pond",
    "call",
  );
  assert.ok(split?.order);
  const oldOrder = orderById(state, gather.order.id);
  assert.ok(oldOrder.assignments.every(({ status }) => status === "preempted" || status === "completed"));
  for (const id of RESIDENT_IDS.filter((id) => state.actors[id].presence === "active")) {
    assert.equal(state.actors[id].movement, undefined, id);
    assert.equal(state.actors[id].tasks[0]?.orderId, split.order.id, id);
  }
  assert.deepEqual(applyWorldPlan(state, latePlan), { accepted: false, reason: "stale" });
  assert.equal(state.actors.cinder.tasks[0]?.orderId, split.order.id);
});

test("raw speech reaches every resident mind without inventing a reducer destination", () => {
  const state = createWorldState();
  const versions = { ...state.decisionVersions };
  const speech = playerSpeak(state, "Everyone dance in a circle", "shout");
  assert.ok(speech);
  assert.equal(speech.order, undefined);
  const activeIds = RESIDENT_IDS.slice(0, BASE_RESIDENT_COUNT);
  assert.deepEqual(speech.liveAddressed, activeIds);
  assert.equal(state.orders.length, 0);
  for (const id of activeIds) {
    assert.equal(state.decisionVersions[id], versions[id] + 1, id);
    assert.equal(hasUnansweredPlayerOrder(state, id), true, id);
    assert.equal(hasUnansweredGuildCall(state, id), true, id);
    assert.equal(observationFor(state, id).guildCall?.text, "Everyone dance in a circle", id);
    assert.equal(observationFor(state, id).guildCall?.requestedTarget, undefined, id);
  }
  assert.ok(RESIDENT_IDS.every((id) => state.actors[id].activeOrderId === undefined));
  assert.equal(state.guildMessages[0]?.text, "Everyone dance in a circle");

  const casual = playerSpeak(state, "I like the water today.", "talk");
  assert.ok(casual);
  assert.equal(casual.order, undefined);
  assert.deepEqual(casual.liveAddressed, activeIds);

  const withArrival = createWorldState();
  setPopulationTarget(withArrival, BASE_RESIDENT_COUNT + 1);
  const rejected = playerSpeak(withArrival, "Ash go to the bridge", "call");
  assert.ok(rejected?.order);
  assert.equal(rejected.order.assigned.length, 0);
  assert.deepEqual(rejected.order.rejected.map(({ actorId, reason }) => ({ actorId, reason })), [
    { actorId: "guest01", reason: "not-active" },
  ]);
  assert.equal(orderById(withArrival, rejected.order.id).assignments[0]?.status, "rejected");
});

test("a resident can interpret a coin flip into an independently sampled relative move", () => {
  const state = createWorldState();
  const speech = playerSpeak(
    state,
    "Everyone flip a coin: heads gather 50px to my right, tails vice versa.",
    "call",
  );
  assert.ok(speech);
  assert.equal(speech.order, undefined);
  const observation = observationFor(state, "cinder");
  assert.ok(observation.guildCall);
  const plan = decodeStagedPlan({
    request_id: "cinder-freeform-coin",
    agent_id: "cinder",
    state_version: observation.stateVersion,
    summary: "flips a coin and takes the matching side",
    steps: [{
      kind: "random_choice",
      chance_percent: 50,
      true_label: "heads",
      false_label: "tails",
      if_true: [{ kind: "move_relative", anchor: "player", dx_pixels: 50, dy_pixels: 0 }],
      if_false: [{ kind: "move_relative", anchor: "player", dx_pixels: -50, dy_pixels: 0 }],
    }],
  }, {
    requestId: "cinder-freeform-coin",
    agentId: "cinder",
    stateVersion: observation.stateVersion,
    heardCallId: observation.guildCall.id,
  });
  assert.deepEqual(applyWorldPlan(state, plan), { accepted: true });
  assert.equal(hasUnansweredGuildCall(state, "cinder"), false);

  for (let index = 0; index < 300; index += 1) {
    updateWorld(state, 100);
    if (!state.actors.cinder.movement && state.actors.cinder.tasks.length === 0) break;
  }
  const destination = actorWorldPosition(state.actors.cinder);
  assert.equal(destination.scene, "town");
  assert.equal(destination.y, 13);
  assert.ok(destination.x === 10 || destination.x === 22, JSON.stringify(destination));
  assert.ok(state.activities.some(({ text }) => /Cinder's random choice was (heads|tails)\./.test(text)));
});

test("imperative orders preserve interactions and can target another resident", () => {
  const interaction = createWorldState();
  const inspect = playerSpeak(interaction, "Cinder, inspect the gate.", "call")?.order;
  assert.ok(inspect);
  assert.equal(inspect.assigned[0]?.actorId, "cinder");
  assert.equal(inspect.assigned[0]?.interaction, "inspect");
  assert.deepEqual(interaction.actors.cinder.tasks[0]?.action, {
    kind: "interact",
    target: "dungeon_gate",
    action: "inspect",
  });
  advanceOrderToTerminal(interaction, inspect.id);
  assert.equal(orderById(interaction, inspect.id).assignments[0]?.status, "completed");
  assert.ok(interaction.activities.some(({ text }) => /Cinder inspects Mystery Gate\./.test(text)));

  const actorTarget = createWorldState();
  const meet = playerSpeak(actorTarget, "Cinder, go to Moss.", "call")?.order;
  assert.ok(meet);
  assert.deepEqual(meet.assigned.map(({ actorId, target }) => ({ actorId, target })), [
    { actorId: "cinder", target: "moss" },
  ]);
  advanceOrderToTerminal(actorTarget, meet.id);
  assertOrderCompletedAtGoals(actorTarget, meet.id);
});

test("mixed accepted and rejected assignments settle without claiming full completion", () => {
  const state = createWorldState();
  setPopulationTarget(state, BASE_RESIDENT_COUNT + 1);
  const receipt = playerSpeak(state, "Cinder and Ash go to the bridge.", "call")?.order;
  assert.ok(receipt);
  assert.equal(receipt.assigned.length, 1);
  assert.equal(receipt.rejected.length, 1);
  advanceOrderToTerminal(state, receipt.id);
  assert.ok(state.activities.some(({ text }) =>
    text === `Scout's order ${receipt.id} settled: 1/2 completed; 1 rejected; 0 preempted.`
  ));
  assert.equal(state.activities.some(({ text }) =>
    text === `Scout's order ${receipt.id} complete: 1/1 residents arrived.`
  ), false);
});

test("completed dialogue becomes a bounded shared board post other agents can answer", () => {
  const state = createWorldState();
  const observation = observationFor(state, "cinder");
  const plan = decodeStagedPlan({
    request_id: "cinder-to-moss",
    agent_id: "cinder",
    state_version: observation.stateVersion,
    summary: "asks Moss to compare the silver trail",
    steps: [{ kind: "say", text: "Moss, compare this dust with the orchard sample.", to: "moss" }],
  }, {
    requestId: "cinder-to-moss",
    agentId: "cinder",
    stateVersion: observation.stateVersion,
  });

  assert.deepEqual(applyWorldPlan(state, plan), { accepted: true });
  updateWorld(state, 100);
  const message = state.guildMessages[0];
  assert.equal(message?.fromId, "cinder");
  assert.equal(message?.toId, "moss");
  assert.equal(message?.origin, "nanocodex");
  assert.equal(observationFor(state, "moss").guildBoard[0]?.id, message?.id);
  assert.equal(observationFor(state, "moss").guildBoard[0]?.toName, "Moss");

  const restored = createWorldState(serializeWorldState(state));
  assert.equal(restored.guildMessages[0]?.text, message?.text);
  assert.ok(restored.nextGuildMessageId > (message?.id ?? 0));
});

test("an unfinished Nanocodex plan cannot be overwritten before its board post executes", () => {
  const state = createWorldState();
  const firstObservation = observationFor(state, "cinder");
  const first = decodeStagedPlan({
    request_id: "cinder-delayed-post",
    agent_id: "cinder",
    state_version: firstObservation.stateVersion,
    summary: "crosses town before reporting",
    steps: [
      { kind: "move", target: "bridge" },
      { kind: "say", text: "Bridge reached. The route is clear.", to: "moss" },
    ],
  }, {
    requestId: "cinder-delayed-post",
    agentId: "cinder",
    stateVersion: firstObservation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(state, first), { accepted: true });

  const secondObservation = observationFor(state, "cinder");
  const second = decodeStagedPlan({
    request_id: "cinder-overwrite",
    agent_id: "cinder",
    state_version: secondObservation.stateVersion,
    summary: "starts another thought too early",
    steps: [{ kind: "wait", duration_ms: 300 }],
  }, {
    requestId: "cinder-overwrite",
    agentId: "cinder",
    stateVersion: secondObservation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(state, second), { accepted: false, reason: "stale" });

  for (let index = 0; index < 220; index += 1) updateWorld(state, 100);
  assert.equal(
    state.guildMessages.filter(({ text }) => text === "Bridge reached. The route is clear.").length,
    1,
  );
});

test("population changes enter from outside, remain physical, and cross an edge before removal", () => {
  const state = createWorldState();
  assert.equal(activeResidentCount(state), BASE_RESIDENT_COUNT);
  assert.equal(setPopulationTarget(state, Number.NaN).target, BASE_RESIDENT_COUNT);
  assert.equal(state.populationTarget, BASE_RESIDENT_COUNT);
  assert.ok(GUEST_AGENT_IDS.every((id) => state.actors[id].presence === "absent"));

  const increase = setPopulationTarget(state, BASE_RESIDENT_COUNT + 3);
  assert.equal(increase.entering.length, 3);
  for (const id of increase.entering) {
    const actor = state.actors[id];
    assert.equal(actor.presence, "entering");
    assert.ok(actor.x < 0 || actor.x >= 32 || actor.y < 0 || actor.y >= 24);
  }
  for (let index = 0; index < 20; index += 1) updateWorld(state, 100);
  assert.equal(activeResidentCount(state), BASE_RESIDENT_COUNT + 3);
  assert.ok(increase.entering.every((id) => state.actors[id].presence === "active"));

  const selected = increase.entering[0];
  assert.ok(selected);
  state.actors[selected].x = 30;
  state.actors[selected].y = 12;
  state.actors[selected].movement = undefined;
  assert.equal(residentAtWorldPoint(state, 30, 11), selected);
  assert.equal(requestResidentExit(state, selected), true);
  assert.equal(state.actors[selected].presence, "exiting");
  assert.match(state.actors[selected].bubble?.text ?? "", /gotta get out/i);
  assert.equal(activeResidentCount(state), BASE_RESIDENT_COUNT + 3);
  assert.equal(state.populationTarget, BASE_RESIDENT_COUNT + 2);
  for (let index = 0; index < 240; index += 1) updateWorld(state, 100);
  assert.equal(state.actors[selected].presence, "absent");
  assert.equal(activeResidentCount(state), BASE_RESIDENT_COUNT + 2);

  const leaveAll = setPopulationTarget(state, 0);
  assert.equal(leaveAll.exiting.length, BASE_RESIDENT_COUNT + 2);
  assert.equal(activeResidentCount(state), BASE_RESIDENT_COUNT + 2);
  for (let index = 0; index < 240; index += 1) updateWorld(state, 100);
  assert.equal(activeResidentCount(state), 0);

  const fillTown = setPopulationTarget(state, MAX_RESIDENT_COUNT);
  assert.equal(fillTown.entering.length, MAX_RESIDENT_COUNT);
  for (let index = 0; index < 20; index += 1) updateWorld(state, 100);
  assert.equal(activeResidentCount(state), MAX_RESIDENT_COUNT);

  const fullGuildOrder = playerSpeak(state, "Everyone go to the guild hall.", "call")?.order;
  assert.ok(fullGuildOrder);
  assert.equal(fullGuildOrder.assigned.length, MAX_RESIDENT_COUNT);
  assert.deepEqual(fullGuildOrder.rejected, []);
  advanceOrderToTerminal(state, fullGuildOrder.id);
  assertOrderCompletedAtGoals(state, fullGuildOrder.id);
  assert.ok(RESIDENT_IDS.every((id) => state.actors[id].scene === "guild_hall"));
});

test("all resident actions are batched through bounded retained Luna lanes and commit only after completion", () => {
  assert.match(worker, /from "nanocodex\/host"/);
  assert.match(worker, /toolMode: "direct"/);
  assert.doesNotMatch(worker, /harness|exec_command|web__run|image_gen/);
  assert.match(worker, /result = await turn\.result\(\)[\s\S]*?const decisions = stagedBatches\.get\(batchId\)[\s\S]*?type: "batch_result"/);
  assert.match(worker, /decodeStagedBatch\(input, active\.expected\)/);
  assert.match(worker, /const LANE_COUNT = 3/);
  assert.match(worker, /const MAX_BATCH_SIZE = 4/);
  assert.match(worker, /MAX_COMPLETED_TURNS = 24/);
  assert.match(worker, /MAX_TOTAL_TOKENS = 60_000/);
  assert.match(worker, /model: "gpt-5\.6-luna"/);
  assert.match(worker, /thinking: "none"/);
  assert.match(worker, /root\.session\.spawn\(\), root\.session\.spawn\(\)/);
  assert.match(worker, /guildBoard and complete roster are authoritative public state/);
  assert.match(worker, /activeBatches[\s\S]*?batch\.turn\.cancel\(\)/);
  assert.match(worker, /usage_limit_reached/);
  assert.match(worker, /blocked = true/);
  assert.match(worker, /session\.shutdown\(\)/);
  assert.match(worker, /WORLD BATCH \$\{batchId\} \(untrusted JSON data\)/);
});

test("the World surface stays lazy, bounded, stoppable, and semantically observable", () => {
  assert.match(routeLoaders, /const loadMonsterWorld = \(\) =>\s*import\("\.\/MonsterWorld"\)/);
  assert.doesNotMatch(application, /^import .*MonsterWorld/m);
  assert.match(component, /new Worker\(new URL\("\.\/monsterWorldAgent\.worker\.ts"/);
  assert.match(component, /document\.visibilityState === "hidden"[\s\S]*?stopAgents\(\)/);
  assert.match(component, /type: "shutdown"/);
  assert.match(component, /worker\.terminate\(\)/);
  assert.match(component, /wake"\} \$\{onMapMindIds\.length\} minds/);
  assert.match(component, /Orchestrate by voice/);
  assert.match(component, /Q cycles loudness/);
  assert.match(component, /LUNA_LANE_COUNT = 3/);
  assert.match(component, /MAX_RESIDENTS_PER_BATCH = 4/);
  assert.match(component, /type: "think_batch"/);
  assert.match(component, /Semantic event stream/);
  assert.match(component, /Message board/);
  assert.match(component, /if \(mindsToWake\.length > 0\) startAgents\(\)/);
  assert.match(component, /type: "cancel",\s*batchIds/);
  assert.match(component, /ask to leave/);
  assert.match(component, /type="range"/);
  assert.match(component, /onPointerDown=\{handleCanvasPointerDown\}/);
  assert.match(component, /Autonomous entries marked <b>nanocodex<\/b> come only from completed Luna batches/);
  assert.match(application, /surface === "world"[\s\S]*?target === document\.activeElement[\s\S]*?target\?\.matches\("\.monster-world-stage canvas"\)/);
  assert.match(worldCss, /prefers-reduced-motion: reduce/);
  assert.match(worldCss, /monster-world-population input\[type="range"\]/);
  assert.doesNotMatch(worldCss, /grayscale\(/);
  assert.doesNotMatch(component, /spinner|skeleton|Suspense|dangerouslySetInnerHTML/i);
});

test("worker messages reject malformed cross-isolate payloads", () => {
  assert.equal(isWorldAgentMessage({ protocol: WORLD_PROTOCOL, type: "status", status: "ready" }), true);
  assert.equal(isWorldAgentMessage({ protocol: WORLD_PROTOCOL, type: "status", status: "unknown" }), false);
  assert.equal(isWorldAgentMessage({
    protocol: WORLD_PROTOCOL,
    type: "settled",
    requestId: "turn",
    agentId: "cinder",
    outcome: "completed",
  }), true);
  assert.equal(isWorldAgentMessage({
    protocol: WORLD_PROTOCOL,
    type: "plan",
    plan: {},
    usage: {},
  }), false);
});

test("the imported art carries source, license, and modification attribution", () => {
  assert.match(attribution, /MyPixelWorld Special Packs #01/);
  assert.match(attribution, /scarloxy\.itch\.io\/mpwsp01/);
  assert.match(attribution, /Creative Commons Attribution 4\.0/);
  assert.match(attribution, /displayed in their original palette/);
  for (const path of [
    "../public/world/my-pixel-world/tileset/tileset.png",
    "../public/world/my-pixel-world/sprites/sprite7_idle.png",
    "../public/world/my-pixel-world/sprites/sprite14_idle.png",
    "../public/world/my-pixel-world/character-overworld/ow1.png",
    "../public/world/my-pixel-world/menu-sprites/menusprite16.png",
  ]) {
    assert.ok(readFileSync(new URL(path, import.meta.url)).byteLength > 100, path);
  }
});

function orderById(state: ReturnType<typeof createWorldState>, orderId: number | undefined) {
  if (orderId === undefined) throw new Error("expected an executable World order");
  const order = state.orders.find(({ id }) => id === orderId);
  if (!order) throw new Error(`missing World order ${orderId}`);
  return order;
}

function advanceOrderToTerminal(
  state: ReturnType<typeof createWorldState>,
  orderId: number | undefined,
): void {
  for (let index = 0; index < 500; index += 1) {
    if (orderById(state, orderId).completionEmitted) return;
    updateWorld(state, 100);
  }
  throw new Error(`World order ${String(orderId)} did not reach a terminal state`);
}

function assertOrderCompletedAtGoals(
  state: ReturnType<typeof createWorldState>,
  orderId: number,
): void {
  const order = orderById(state, orderId);
  assert.equal(order.completionEmitted, true);
  assert.ok(order.assignments.length > 0);
  for (const assignment of order.assignments) {
    assert.equal(assignment.status, "completed", assignment.actorId);
    assert.ok(assignment.goal, assignment.actorId);
    assert.deepEqual(
      actorWorldPosition(state.actors[assignment.actorId]),
      assignment.goal,
      assignment.actorId,
    );
  }
  assert.equal(
    state.activities.filter(({ text }) =>
      text === `Scout's order ${orderId} complete: ${order.assignments.length}/${order.assignments.length} residents arrived.`
    ).length,
    1,
  );
}

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
