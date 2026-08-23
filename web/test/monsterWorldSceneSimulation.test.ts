import assert from "node:assert/strict";
import test from "node:test";

import {
  RESIDENT_IDS,
  coordinationBasisFor,
  decodeStagedPlan,
  type ResidentId,
  type WorldInteraction,
  type WorldTarget,
} from "../src/monsterWorldProtocol.ts";
import {
  WORLD_POIS,
  isWorldPositionBlocked,
} from "../src/monsterWorldMap.ts";
import {
  WORLD_COLUMNS,
  WORLD_PIXEL_HEIGHT,
  WORLD_PIXEL_WIDTH,
  WORLD_ROWS,
  WORLD_SAVE_KEY,
  actorWorldPosition,
  applyWorldPlan,
  createWorldState,
  movePlayer,
  observationFor,
  playerInteract,
  playerSpeak,
  requestResidentExit,
  serializeWorldState,
  setWorldAgentsOnline,
  updateWorld,
  worldCameraForState,
  type WorldState,
} from "../src/monsterWorldSimulation.ts";

test("Scout traverses both room doors in both directions without bouncing", () => {
  const state = quietWorld();
  const player = state.actors.player;
  assert.equal(WORLD_COLUMNS, 64);
  assert.equal(WORLD_ROWS, 48);
  assert.equal(WORLD_PIXEL_WIDTH, 256);
  assert.equal(WORLD_PIXEL_HEIGHT, 192);

  relocate(state, "player", "town", 6, 8);
  completePlayerStep(state, "up");
  assert.deepEqual(actorWorldPosition(player), { scene: "guild_hall", x: 16, y: 20 });
  assert.deepEqual(worldCameraForState(state), { scene: "guild_hall", x: 0, y: 0 });
  advance(state, 10);
  assert.equal(player.scene, "guild_hall");

  relocate(state, "player", "guild_hall", 16, 21);
  completePlayerStep(state, "down");
  assert.deepEqual(actorWorldPosition(player), { scene: "town", x: 6, y: 8 });

  relocate(state, "player", "town", 26, 8);
  completePlayerStep(state, "up");
  assert.deepEqual(actorWorldPosition(player), { scene: "trail_shop", x: 16, y: 20 });
  advance(state, 10);
  assert.equal(player.scene, "trail_shop");

  relocate(state, "player", "trail_shop", 16, 21);
  completePlayerStep(state, "down");
  assert.deepEqual(actorWorldPosition(player), { scene: "town", x: 26, y: 8 });
  assert.equal(
    state.activities.filter(({ text }) => text === "Scout entered Rescue Guild Hall.").length,
    1,
  );
  assert.equal(
    state.activities.filter(({ text }) => text === "Scout entered Trail Shop.").length,
    1,
  );
});

test("unequal-speed residents reserve a room-door handoff before crossing scenes", () => {
  const ids = ["cinder", "moss"] as const;
  const state = formationWorld(ids);
  relocate(state, "cinder", "town", 6, 8);
  relocate(state, "moss", "town", 5, 7);
  state.actors.cinder.energy = 0;
  state.actors.moss.energy = 100;
  applyMovePlan(state, "cinder", "guild", "slow-guild-door");
  applyMovePlan(state, "moss", "guild", "fast-guild-door");

  advanceFormation(state, ids);
  assert.ok(ids.every((id) => state.actors[id].scene === "guild_hall"));
  assert.equal(new Set(ids.map((id) => positionKey(actorWorldPosition(state.actors[id])))).size, ids.length);
});

test("nonlegacy plans and exact Scout orders retain fixed cross-scene goals", () => {
  const planned = quietWorld();
  const observation = observationFor(planned, "june");
  const plan = decodeStagedPlan({
    request_id: "june-cross-scene-shop",
    agent_id: "june",
    state_version: observation.stateVersion,
    summary: "walks into the trail shop",
    steps: [{ kind: "move", target: "shop" }],
  }, {
    requestId: "june-cross-scene-shop",
    agentId: "june",
    stateVersion: observation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(planned, plan), { accepted: true });
  updateWorld(planned, 100);
  const fixedGoal = planned.actors.june.tasks[0]?.goal;
  assert.ok(fixedGoal);
  assert.equal(fixedGoal.scene, "trail_shop");
  advanceUntil(planned, () => planned.actors.june.tasks.length === 0 && !planned.actors.june.movement);
  assert.deepEqual(actorWorldPosition(planned.actors.june), fixedGoal);
  assert.equal(
    planned.activities.filter(({ text }) => text === "June entered Trail Shop.").length,
    1,
  );

  const ordered = quietWorld();
  const staleVersion = observationFor(ordered, "cinder").stateVersion;
  const receipt = playerSpeak(
    ordered,
    "Cinder go to the guild hall; Moss go to the shop.",
    "call",
  )?.order;
  assert.ok(receipt);
  assert.deepEqual(receipt.rejected, []);
  assert.deepEqual(receipt.assigned.map(({ actorId, target, goal }) => ({
    actorId,
    target,
    scene: goal.scene,
  })), [
    { actorId: "cinder", target: "guild", scene: "guild_hall" },
    { actorId: "moss", target: "shop", scene: "trail_shop" },
  ]);

  const stale = decodeStagedPlan({
    request_id: "cinder-before-cross-scene-order",
    agent_id: "cinder",
    state_version: staleVersion,
    summary: "continues a stale patrol",
    steps: [{ kind: "wait", duration_ms: 300 }],
  }, {
    requestId: "cinder-before-cross-scene-order",
    agentId: "cinder",
    stateVersion: staleVersion,
  });
  assert.deepEqual(applyWorldPlan(ordered, stale), { accepted: false, reason: "stale" });

  advanceUntil(ordered, () => order(ordered, receipt.id).completionEmitted);
  for (const assignment of order(ordered, receipt.id).assignments) {
    assert.equal(assignment.status, "completed", assignment.actorId);
    assert.ok(assignment.goal);
    assert.deepEqual(actorWorldPosition(ordered.actors[assignment.actorId]), assignment.goal);
  }
  assert.equal(
    ordered.activities.filter(({ text }) => text.startsWith(`Scout's order ${receipt.id} complete:`)).length,
    1,
  );
});

test("Scout can complete the orchard-shop-guild supply chain without model decisions", () => {
  const state = quietWorld();
  const player = state.actors.player;

  relocateToPoi(state, "player", "orchard");
  playerInteract(state);
  assert.equal(player.carrying, "sunberry");
  assert.equal(state.supplies.orchardBerries, 7);

  relocateToPoi(state, "player", "shop");
  playerInteract(state);
  assert.equal(player.carrying, undefined);
  assert.equal(state.supplies.shopStock, 2);

  playerInteract(state);
  assert.equal(player.carrying, "supply_pack");
  assert.equal(state.supplies.shopStock, 1);

  relocateToPoi(state, "player", "guild");
  playerInteract(state);
  assert.equal(player.carrying, undefined);
  assert.equal(state.supplies.guildSupplies, 1);
  assert.ok(state.activities.some(({ text }) => /delivered a supply pack/i.test(text)));
});

test("invalid stock, cargo, and location combinations have no economy effect", () => {
  const state = quietWorld();
  const player = state.actors.player;

  state.supplies.orchardBerries = 0;
  relocateToPoi(state, "player", "orchard");
  playerInteract(state);
  assert.equal(player.carrying, undefined);
  assert.equal(state.supplies.orchardBerries, 0);
  assert.match(player.activity, /no ripe sunberries/i);

  state.supplies.orchardBerries = 5;
  player.carrying = "supply_pack";
  playerInteract(state);
  assert.equal(player.carrying, "supply_pack");
  assert.equal(state.supplies.orchardBerries, 5);
  assert.match(player.activity, /while carrying a supply pack/i);

  state.supplies.shopStock = 0;
  player.carrying = undefined;
  relocateToPoi(state, "player", "shop");
  playerInteract(state);
  assert.equal(player.carrying, undefined);
  assert.equal(state.supplies.shopStock, 0);
  assert.match(player.activity, /no supply packs in stock/i);

  state.supplies.shopStock = 2;
  player.carrying = "supply_pack";
  playerInteract(state);
  assert.equal(player.carrying, "supply_pack");
  assert.equal(state.supplies.shopStock, 2);

  relocateToPoi(state, "june", "guild");
  state.actors.june.carrying = "sunberry";
  applyInteractionPlan(state, "june", "guild", "offer", "wrong-guild-cargo");
  assert.equal(state.actors.june.carrying, "sunberry");
  assert.equal(state.supplies.guildSupplies, 0);
  assert.match(state.actors.june.activity, /could not deliver a sunberry/i);

  const energy = state.actors.june.energy;
  const marks = state.supplies.trainingMarks;
  relocateToPoi(state, "june", "shop");
  applyInteractionPlan(state, "june", "shop", "train", "wrong-training-location");
  assert.equal(state.actors.june.energy, energy);
  assert.equal(state.supplies.trainingMarks, marks);
  assert.match(state.actors.june.activity, /could not train safely/i);
});

test("outdoor fatigue is tile-based, low energy still progresses, and guild rest recovers", () => {
  const rested = quietWorld();
  const player = rested.actors.player;
  relocate(rested, "player", "town", 40, 20);
  player.energy = 100;
  assert.equal(movePlayer(rested, "right"), true);
  const normalDuration = player.movement?.durationMs;
  advanceUntil(rested, () => !player.movement, 20);
  assert.equal(player.energy, 99);

  relocate(rested, "player", "town", 40, 20);
  player.energy = 5;
  assert.equal(movePlayer(rested, "left"), true);
  const tiredDuration = player.movement?.durationMs;
  assert.ok(normalDuration !== undefined && tiredDuration !== undefined && tiredDuration > normalDuration);
  advanceUntil(rested, () => !player.movement, 20);
  assert.deepEqual(actorWorldPosition(player), { scene: "town", x: 39, y: 20 });
  assert.equal(player.energy, 4);

  relocateToPoi(rested, "player", "guild");
  player.energy = 5;
  playerInteract(rested);
  assert.equal(player.energy, 37);

  relocateToPoi(rested, "player", "meadow");
  player.energy = 10;
  playerInteract(rested);
  assert.equal(player.energy, 0);
  assert.equal(rested.supplies.trainingMarks, 1);
  playerInteract(rested);
  assert.equal(rested.supplies.trainingMarks, 1);

  const ordered = quietWorld();
  ordered.actors.cinder.energy = 0;
  const receipt = playerSpeak(ordered, "Cinder go to the guild hall.", "call")?.order;
  assert.ok(receipt);
  advanceUntil(ordered, () => order(ordered, receipt.id).completionEmitted, 1_500);
  assert.equal(order(ordered, receipt.id).assignments[0]?.status, "completed");
  assert.equal(ordered.actors.cinder.scene, "guild_hall");
});

test("observations and hearing are scene-aware while the public board and roster remain global", () => {
  const state = quietWorld();
  relocate(state, "player", "town", 40, 20);
  relocate(state, "moss", "town", 41, 20);
  relocate(state, "cinder", "guild_hall", 16, 11);
  state.actors.cinder.carrying = "supply_pack";
  state.supplies.guildSupplies = 3;

  const cinder = observationFor(state, "cinder");
  assert.equal(cinder.self.scene, "guild_hall");
  assert.equal(cinder.self.carrying, "supply_pack");
  assert.equal(cinder.nearby.some(({ id }) => id === "player" || id === "moss"), false);
  assert.equal(cinder.roster.length, 25);
  assert.equal(cinder.roster.find(({ id }) => id === "cinder")?.scene, "guild_hall");
  assert.equal(cinder.roster.find(({ id }) => id === "moss")?.scene, "town");
  assert.deepEqual(cinder.supplies, state.supplies);
  assert.notStrictEqual(cinder.supplies, state.supplies);

  const moss = observationFor(state, "moss");
  assert.equal(moss.self.role, state.actors.moss.role);
  assert.deepEqual({ x: moss.self.x, y: moss.self.y, direction: moss.self.direction }, {
    x: 41,
    y: 20,
    direction: state.actors.moss.direction,
  });
  assert.deepEqual(
    moss.nearby.find(({ id }) => id === "player"),
    {
      id: "player",
      name: state.actors.player.name,
      kind: "player",
      scene: "town",
      x: 40,
      y: 20,
      relativeX: -1,
      relativeY: 0,
      distance: 1,
      direction: state.actors.player.direction,
      activity: state.actors.player.activity,
    },
  );
  assert.equal(moss.nearby.some(({ id }) => id === "player"), true);
  const speech = playerSpeak(state, "Fresh weather report", "whisper");
  assert.ok(speech);
  assert.deepEqual(observationFor(state, "moss").playerOrder?.coListeners, speech.liveAddressed);
  assert.deepEqual(observationFor(state, "moss").guildCall?.coListeners, speech.liveAddressed);
  assert.equal(speech.heardBy.includes("moss"), true);
  assert.equal(speech.heardBy.includes("cinder"), false);
  assert.equal(observationFor(state, "cinder").guildCall, undefined);
  assert.equal(
    observationFor(state, "cinder").guildBoard.some(({ text }) => text === "Fresh weather report"),
    true,
  );
});

test("six situated residents execute stable circle and two-side slots without collisions or swaps", () => {
  const listeners = ["cinder", "moss", "rill", "luma", "iris", "rook"] as const;
  for (const formation of ["radial", "twoSides"] as const) {
    const state = formationWorld(listeners);
    for (const id of listeners) {
      const basis = coordinationBasisFor(listeners, id);
      assert.ok(basis);
      const offset = basis[formation];
      applyRelativePlan(
        state,
        id,
        offset.dxPixels,
        offset.dyPixels,
        `${formation}-${id}`,
      );
    }

    advanceFormation(state, listeners);
    const destinations = listeners.map((id) => actorWorldPosition(state.actors[id]));
    assert.equal(new Set(destinations.map(positionKey)).size, listeners.length);
    assert.deepEqual(destinations, listeners.map((id) => {
      const basis = coordinationBasisFor(listeners, id);
      assert.ok(basis);
      const offset = basis[formation];
      return {
        scene: "town",
        x: state.actors.player.x + offset.dxPixels / 8,
        y: state.actors.player.y + offset.dyPixels / 8,
      };
    }));
  }
});

test("a newly occupied route tile causes a resident to reroute and preserve its claimed goal", () => {
  const state = formationWorld(["cinder"]);
  state.actors.guest01.presence = "active";
  relocate(state, "guest01", "town", 60, 20);
  applyRelativePlan(state, "cinder", 64, 0, "cinder-reroute");
  updateWorld(state, 100);

  const task = state.actors.cinder.tasks[0];
  const blockerStep = task?.path?.[0];
  const goal = task?.goal;
  assert.ok(blockerStep && goal);
  relocate(state, "guest01", blockerStep.scene, blockerStep.x, blockerStep.y);
  const blockedKey = positionKey(blockerStep);
  let rerouted = false;
  for (let index = 0; index < 1_000; index += 1) {
    updateWorld(state, 100);
    assertPhysicalExclusion(state, ["cinder", "guest01"]);
    const currentTask = state.actors.cinder.tasks[0];
    if (currentTask?.path && currentTask.path.every((step) => positionKey(step) !== blockedKey)) {
      rerouted = true;
    }
    if (!currentTask && !state.actors.cinder.movement) break;
  }
  assert.equal(rerouted, true);
  assert.deepEqual(actorWorldPosition(state.actors.cinder), goal);
  assert.deepEqual(actorWorldPosition(state.actors.guest01), blockerStep);
});

test("residents proposing the same relative destination receive distinct physical claims", () => {
  const ids = ["cinder", "moss"] as const;
  const state = formationWorld(ids);
  applyRelativePlan(state, "cinder", 64, 0, "shared-claim-cinder");
  applyRelativePlan(state, "moss", 64, 0, "shared-claim-moss");
  updateWorld(state, 100);

  const goals = ids.map((id) => state.actors[id].tasks[0]?.goal);
  assert.ok(goals.every((goal) => goal !== undefined));
  assert.equal(new Set(goals.map((goal) => positionKey(goal!))).size, ids.length);
  advanceFormation(state, ids);
  assert.equal(
    new Set(ids.map((id) => positionKey(actorWorldPosition(state.actors[id])))).size,
    ids.length,
  );
});

test("v3 persistence retains scenes, cargo, supplies, and the deterministic restock timer", () => {
  const state = quietWorld();
  relocate(state, "player", "guild_hall", 16, 11);
  state.actors.player.carrying = "supply_pack";
  relocate(state, "june", "trail_shop", 16, 10);
  state.actors.june.carrying = "sunberry";
  Object.assign(state.supplies, {
    orchardBerries: 3,
    shopStock: 2,
    guildSupplies: 4,
    trainingMarks: 5,
  });
  state.orchardRestockDueMs = 12_345;
  state.weatherDueMs = 23_456;
  playerSpeak(state, "Weather log checkpoint", "talk");

  const saved = serializeWorldState(state);
  const payload = JSON.parse(saved) as Record<string, any>;
  assert.equal(WORLD_SAVE_KEY, "nanocodex-monster-world-v3");
  assert.equal(payload.version, 3);
  assert.deepEqual(payload.actors.player.position, { scene: "guild_hall", x: 16, y: 11 });
  assert.equal("x" in payload.actors.player, false);

  const restored = createWorldState(saved);
  assert.deepEqual(actorWorldPosition(restored.actors.player), { scene: "guild_hall", x: 16, y: 11 });
  assert.equal(restored.actors.player.carrying, "supply_pack");
  assert.deepEqual(actorWorldPosition(restored.actors.june), { scene: "trail_shop", x: 16, y: 10 });
  assert.equal(restored.actors.june.carrying, "sunberry");
  assert.deepEqual(restored.supplies, state.supplies);
  assert.equal(restored.orchardRestockDueMs, 12_345);
  assert.equal(restored.weatherDueMs, 23_456);
  assert.ok(restored.activities.some(({ text }) => text.includes("Weather log checkpoint")));
  assert.ok(restored.nextActivityId > Math.max(...restored.activities.map(({ id }) => id)));

  payload.actors.player.position = { scene: "missing_room", x: 2, y: 2 };
  payload.actors.player.carrying = "silver_bell";
  payload.actors.june.position = { scene: "trail_shop", x: 0, y: 0 };
  payload.supplies = { orchardBerries: -1, shopStock: 99, guildSupplies: 99, trainingMarks: 99 };
  payload.orchardRestockDueMs = "soon";
  payload.weatherDueMs = "later";
  payload.activities = [{ id: 1, minuteOfDay: 0, origin: "system", text: "" }];
  const malformed = createWorldState(JSON.stringify(payload));
  assert.deepEqual(actorWorldPosition(malformed.actors.player), { scene: "town", x: 16, y: 13 });
  assert.equal(malformed.actors.player.carrying, undefined);
  assert.equal(malformed.actors.june.scene, "town");
  assert.deepEqual(malformed.supplies, {
    orchardBerries: 8,
    shopStock: 1,
    guildSupplies: 0,
    trainingMarks: 0,
  });
  assert.equal(malformed.orchardRestockDueMs, 30_000);
  assert.equal(malformed.weatherDueMs, 58_000);

  malformed.supplies.orchardBerries = 7;
  malformed.orchardRestockDueMs = malformed.elapsedMs + 100;
  updateWorld(malformed, 100);
  assert.equal(malformed.supplies.orchardBerries, 8);
  assert.equal(malformed.orchardRestockDueMs, malformed.elapsedMs + 30_000);
});

test("an indoor resident exits through a room door before crossing a town boundary", () => {
  const state = quietWorld();
  relocate(state, "cinder", "guild_hall", 16, 11);
  assert.equal(requestResidentExit(state, "cinder"), true);
  const scenes = new Set([state.actors.cinder.scene]);
  advanceUntil(state, () => {
    scenes.add(state.actors.cinder.scene);
    return state.actors.cinder.presence === "absent";
  }, 2_000);
  assert.equal(scenes.has("town"), true);
  assert.equal(state.actors.cinder.presence, "absent");
  assert.ok(
    state.activities.some(({ text }) => text === "Cinder entered Springleaf District."),
  );
});

function quietWorld(): WorldState {
  const state = createWorldState();
  setWorldAgentsOnline(state, true);
  return state;
}

function formationWorld(ids: readonly ResidentId[]): WorldState {
  const state = quietWorld();
  for (const id of RESIDENT_IDS) {
    if (ids.includes(id)) continue;
    Object.assign(state.actors[id], {
      presence: "absent",
      movement: undefined,
      tasks: [],
      departure: undefined,
    });
  }
  relocate(state, "player", "town", 32, 24);
  ids.forEach((id, index) => relocate(state, id, "town", 10 + index * 2, 20));
  return state;
}

function applyRelativePlan(
  state: WorldState,
  actorId: ResidentId,
  dxPixels: number,
  dyPixels: number,
  requestId: string,
): void {
  const observation = observationFor(state, actorId);
  const plan = decodeStagedPlan({
    request_id: requestId,
    agent_id: actorId,
    state_version: observation.stateVersion,
    summary: "takes a distinct situated coordination slot",
    steps: [{
      kind: "move_relative",
      anchor: "player",
      dx_pixels: dxPixels,
      dy_pixels: dyPixels,
    }],
  }, {
    requestId,
    agentId: actorId,
    stateVersion: observation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(state, plan), { accepted: true });
}

function applyMovePlan(
  state: WorldState,
  actorId: ResidentId,
  target: WorldTarget,
  requestId: string,
): void {
  const observation = observationFor(state, actorId);
  const plan = decodeStagedPlan({
    request_id: requestId,
    agent_id: actorId,
    state_version: observation.stateVersion,
    summary: `moves to ${target}`,
    steps: [{ kind: "move", target }],
  }, {
    requestId,
    agentId: actorId,
    stateVersion: observation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(state, plan), { accepted: true });
}

function advanceFormation(state: WorldState, ids: readonly ResidentId[]): void {
  for (let index = 0; index < 1_000; index += 1) {
    updateWorld(state, 100);
    assertPhysicalExclusion(state, ids);
    if (ids.every((id) => state.actors[id].tasks.length === 0 && !state.actors[id].movement)) return;
  }
  assert.fail("formation did not settle within 1,000 ticks");
}

function assertPhysicalExclusion(state: WorldState, ids: readonly ResidentId[]): void {
  const actors = ids.map((id) => state.actors[id]);
  assert.equal(new Set(actors.map((actor) => positionKey(actorWorldPosition(actor)))).size, actors.length);
  const moving = actors.filter((actor) => actor.movement !== undefined);
  assert.equal(new Set(moving.map((actor) => positionKey(actor.movement!.to))).size, moving.length);
  for (let left = 0; left < moving.length; left += 1) {
    for (let right = left + 1; right < moving.length; right += 1) {
      const a = moving[left]?.movement;
      const b = moving[right]?.movement;
      assert.ok(a && b);
      assert.equal(
        positionKey(a.from) === positionKey(b.to) && positionKey(a.to) === positionKey(b.from),
        false,
      );
    }
  }
}

function positionKey(position: { scene: string; x: number; y: number }): string {
  return `${position.scene}:${position.x},${position.y}`;
}

function relocate(
  state: WorldState,
  actorId: "player" | ResidentId,
  scene: "town" | "guild_hall" | "trail_shop",
  x: number,
  y: number,
): void {
  const position = { scene, x, y } as const;
  assert.equal(isWorldPositionBlocked(position), false, `${actorId} test position must be walkable`);
  Object.assign(state.actors[actorId], {
    scene,
    x,
    y,
    movement: undefined,
    departure: undefined,
  });
}

function relocateToPoi(
  state: WorldState,
  actorId: "player" | ResidentId,
  target: Exclude<WorldTarget, "player" | ResidentId>,
): void {
  const poi = WORLD_POIS[target];
  relocate(state, actorId, poi.scene, poi.x, poi.y);
}

function completePlayerStep(
  state: WorldState,
  direction: "up" | "down" | "left" | "right",
): void {
  assert.equal(movePlayer(state, direction), true);
  advanceUntil(state, () => !state.actors.player.movement, 20);
}

function applyInteractionPlan(
  state: WorldState,
  actorId: ResidentId,
  target: WorldTarget,
  interaction: WorldInteraction,
  requestId: string,
): void {
  const observation = observationFor(state, actorId);
  const plan = decodeStagedPlan({
    request_id: requestId,
    agent_id: actorId,
    state_version: observation.stateVersion,
    summary: `tries ${interaction} at ${target}`,
    steps: [{ kind: "interact", target, action: interaction }],
  }, {
    requestId,
    agentId: actorId,
    stateVersion: observation.stateVersion,
  });
  assert.deepEqual(applyWorldPlan(state, plan), { accepted: true });
  advanceUntil(state, () => state.actors[actorId].tasks.length === 0, 50);
}

function advance(state: WorldState, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) updateWorld(state, 100);
}

function advanceUntil(
  state: WorldState,
  done: () => boolean,
  maximumTicks = 1_000,
): void {
  for (let index = 0; index < maximumTicks && !done(); index += 1) updateWorld(state, 100);
  assert.equal(done(), true, `condition did not settle within ${maximumTicks} ticks`);
}

function order(state: WorldState, id: number) {
  const found = state.orders.find((candidate) => candidate.id === id);
  assert.ok(found);
  return found;
}
