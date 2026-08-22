import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTONOMOUS_AGENT_IDS,
  decodeStagedPlan,
  type WorldResidentMemory,
} from "../src/monsterWorldProtocol.ts";
import {
  BASE_RESIDENT_COUNT,
  applyResidentMemory,
  applyWorldPlan,
  createWorldState,
  hasUnansweredGuildCall,
  liveAgentIdsInWorld,
  observationFor,
  playerSpeak,
  requestResidentExit,
  residentMemoryFor,
  serializeWorldState,
  setPopulationTarget,
  setWorldAgentsOnline,
  updateWorld,
} from "../src/monsterWorldSimulation.ts";

test("every on-map resident has autonomous state and bounded retained memory", () => {
  const state = createWorldState();
  const activeIds = liveAgentIdsInWorld(state);
  assert.equal(activeIds.length, BASE_RESIDENT_COUNT);
  assert.deepEqual(activeIds, AUTONOMOUS_AGENT_IDS.slice(0, BASE_RESIDENT_COUNT));
  assert.deepEqual(Object.keys(state.decisionVersions), AUTONOMOUS_AGENT_IDS);
  assert.deepEqual(Object.keys(state.residentMemories), AUTONOMOUS_AGENT_IDS);
  assert.notStrictEqual(residentMemoryFor(state, "cinder"), residentMemoryFor(state, "june"));
  assert.notStrictEqual(
    residentMemoryFor(state, "cinder").goals,
    residentMemoryFor(state, "june").goals,
  );

  const goals = ["Inspect Bell Bridge"];
  const memory: WorldResidentMemory = {
    summary: "June is carrying guild dispatches.",
    goals,
    relationships: ["Scout gives physical orders."],
    recentDecisions: ["Read the newest public board post."],
    lastBoardMessageId: 7,
  };
  applyResidentMemory(state, "june", memory);
  goals.push("Mutate the caller-owned array");
  assert.deepEqual(residentMemoryFor(state, "june").goals, ["Inspect Bell Bridge"]);
  assert.equal(Object.isFrozen(residentMemoryFor(state, "june")), true);
  assert.equal(Object.isFrozen(residentMemoryFor(state, "june").goals), true);

  const restored = createWorldState(serializeWorldState(state));
  assert.deepEqual(residentMemoryFor(restored, "june"), residentMemoryFor(state, "june"));

  const malformed = JSON.parse(serializeWorldState(state)) as Record<string, unknown>;
  (malformed.residentMemories as Record<string, unknown>).june = {
    summary: ["not text"],
    goals: "not a list",
    lastBoardMessageId: -1,
  };
  assert.deepEqual(residentMemoryFor(createWorldState(JSON.stringify(malformed)), "june"), {
    summary: "",
    goals: [],
    relationships: [],
    recentDecisions: [],
    lastBoardMessageId: 0,
  });
});

test("speech, observations, calls, and plans include non-legacy residents", () => {
  const state = createWorldState();
  const activeIds = liveAgentIdsInWorld(state);
  const versions = { ...state.decisionVersions };
  const speech = playerSpeak(state, "Everyone go to the bridge.", "whisper");
  assert.ok(speech?.order);
  assert.deepEqual(speech.liveHeardBy, activeIds);
  assert.deepEqual(speech.liveAddressed, activeIds);
  for (const id of activeIds) {
    assert.equal(state.decisionVersions[id], versions[id] + 1);
    assert.equal(hasUnansweredGuildCall(state, id), true);
    assert.equal(observationFor(state, id).guildCall?.requestedTarget, "bridge");
  }

  const planState = createWorldState();
  const observation = observationFor(planState, "june");
  const plan = decodeStagedPlan({
    request_id: "june-autonomous-1",
    agent_id: "june",
    state_version: observation.stateVersion,
    summary: "checks the public mission board",
    steps: [{ kind: "move", target: "mission_board" }],
  }, {
    requestId: "june-autonomous-1",
    agentId: "june",
    stateVersion: observation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(planState, plan), { accepted: true });
});

test("resident lifecycle and global weather changes fence every affected decision", () => {
  const lifecycle = createWorldState();
  const guestVersion = lifecycle.decisionVersions.guest01;
  assert.deepEqual(setPopulationTarget(lifecycle, BASE_RESIDENT_COUNT + 1).entering, ["guest01"]);
  assert.equal(lifecycle.decisionVersions.guest01, guestVersion + 1);
  for (let index = 0; index < 20; index += 1) updateWorld(lifecycle, 100);
  const activeVersion = observationFor(lifecycle, "guest01").stateVersion;
  assert.equal(requestResidentExit(lifecycle, "guest01"), true);
  assert.equal(lifecycle.decisionVersions.guest01, activeVersion + 1);

  const weather = createWorldState();
  const versions = { ...weather.decisionVersions };
  weather.weatherDueMs = 0;
  updateWorld(weather, 100);
  for (const id of AUTONOMOUS_AGENT_IDS) {
    assert.equal(weather.decisionVersions[id], versions[id] + 1, id);
  }
});

test("online Luna control suppresses only new idle fallback routines", () => {
  const transitioning = createWorldState();
  for (let index = 0; index < 15; index += 1) updateWorld(transitioning, 100);
  assert.ok(transitioning.actors.cinder.movement);
  assert.ok(transitioning.actors.cinder.tasks.some(({ origin }) => origin === "routine"));
  setWorldAgentsOnline(transitioning, true);
  assert.ok(transitioning.actors.cinder.movement);
  assert.equal(transitioning.actors.cinder.tasks.length, 0);
  for (let index = 0; index < 100; index += 1) updateWorld(transitioning, 100);
  assert.equal(transitioning.actors.cinder.movement, undefined);
  assert.equal(transitioning.actors.cinder.tasks.length, 0);

  const state = createWorldState();
  const activeIds = liveAgentIdsInWorld(state);
  const routineIndexes = Object.fromEntries(
    activeIds.map((id) => [id, state.actors[id].routineIndex]),
  );
  setWorldAgentsOnline(state, true);
  for (let index = 0; index < 200; index += 1) updateWorld(state, 100);
  for (const id of activeIds) {
    assert.equal(state.actors[id].routineIndex, routineIndexes[id]);
    assert.equal(state.actors[id].tasks.length, 0);
  }

  const order = playerSpeak(state, "Everyone go to the pond.", "call")?.order;
  assert.ok(order);
  updateWorld(state, 100);
  assert.ok(activeIds.every((id) => state.actors[id].tasks[0]?.orderId === order.id));
  assert.ok(activeIds.some((id) => state.actors[id].movement !== undefined));

  const fallback = createWorldState();
  setWorldAgentsOnline(fallback, true);
  for (let index = 0; index < 200; index += 1) updateWorld(fallback, 100);
  setWorldAgentsOnline(fallback, false);
  updateWorld(fallback, 100);
  assert.ok(liveAgentIdsInWorld(fallback).every((id) => fallback.actors[id].tasks.length > 0));
});
