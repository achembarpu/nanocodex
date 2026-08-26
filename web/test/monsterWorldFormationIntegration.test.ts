import assert from "node:assert/strict";
import test from "node:test";

import {
  RESIDENT_IDS,
  type ResidentId,
  type WorldPrimitiveAction,
} from "../src/monsterWorldProtocol.ts";
import {
  actorWorldPosition,
  applyWorldToolAction,
  createWorldState,
  formationSnapshotFor,
  setWorldAgentsOnline,
  updateWorld,
  worldToolResultAtDecisionBoundary,
  type WorldState,
} from "../src/monsterWorldSimulation.ts";
import { WORLD_PORTALS } from "../src/monsterWorldMap.ts";

type FormationAction = Extract<WorldPrimitiveAction, { kind: "maintain_formation" }>;

test("formation members route out of both interior scenes to a player-anchored town formation", () => {
  const state = formationWorld(["cinder", "moss"]);
  relocate(state, "cinder", "guild_hall", 16, 10);
  relocate(state, "moss", "trail_shop", 16, 10);
  const path = [
    { x: -3, y: -3 },
    { x: 3, y: -3 },
    { x: 3, y: 3 },
    { x: -3, y: 3 },
  ] as const;

  assert.equal(applyFormation(state, "cinder", formationAction({
    generation: 1,
    formation_id: "interior-egress",
    path_tiles: path,
    region_index: 0,
    region_count: 2,
    members: ["cinder", "moss"],
  })).accepted, true);
  assert.equal(applyFormation(state, "moss", formationAction({
    generation: 1,
    formation_id: "interior-egress",
    path_tiles: path,
    region_index: 1,
    region_count: 2,
    members: ["moss", "cinder"],
  })).accepted, true);

  advanceUntil(state, () => ["cinder", "moss"].every((id) => {
    const actor = state.actors[id as ResidentId];
    return actor.scene === "town"
      && actor.movement === undefined
      && actor.activity.startsWith("holding formation");
  }), 2_000);

  assert.ok(["cinder", "moss"].every((id) => state.actors[id as ResidentId].scene === "town"));
  assert.ok(state.activities.some(({ actorId, text }) => (
    actorId === "cinder" && text === "Cinder entered Springleaf District."
  )));
  assert.ok(state.activities.some(({ actorId, text }) => (
    actorId === "moss" && text === "Moss entered Springleaf District."
  )));
});

test("formation targets keep portal approaches and landings clear for a queued swarm", () => {
  const members = ["cinder", "moss", "rill", "luma"] as const;
  const state = formationWorld(members);
  relocate(state, "cinder", "town", 6, 8);
  relocate(state, "moss", "guild_hall", 16, 20);
  relocate(state, "rill", "guild_hall", 16, 21);
  relocate(state, "luma", "guild_hall", 16, 22);
  relocate(state, "player", "town", 6, 9);
  const action = formationAction({
    generation: 8,
    formation_id: "portal-clearance",
    closed: false,
    path_tiles: [{ x: 0, y: -1 }, { x: 3, y: -1 }],
    region_count: 2,
    members: [...members],
  });

  members.forEach((residentId, index) => {
    assert.equal(applyFormation(state, residentId, {
      ...action,
      region_index: index < 2 ? 0 : 1,
    }).accepted, true);
  });
  advanceUntil(state, () => members.every((residentId) => (
    state.actors[residentId].scene === "town"
    && state.actors[residentId].movement === undefined
    && state.actors[residentId].activity.startsWith("holding formation")
  )), 2_000);

  const endpoints = new Set(WORLD_PORTALS.flatMap(({ from, to }) => [positionKey(from), positionKey(to)]));
  assert.ok(members.every((residentId) => !endpoints.has(positionKey(actorWorldPosition(state.actors[residentId])))));
});

test("formation target selection avoids Scout and non-member current and reserved tiles", () => {
  const state = formationWorld(["cinder", "moss", "rill"]);
  relocate(state, "cinder", "town", 8, 10);
  relocate(state, "moss", "town", 16, 12);
  relocate(state, "rill", "town", 15, 12);
  state.actors.rill.movement = {
    from: actorWorldPosition(state.actors.rill),
    to: { scene: "town", x: 15, y: 13 },
    progress: 0,
    durationMs: 1_000_000,
  };
  const forbidden = new Set([
    positionKey(actorWorldPosition(state.actors.player)),
    positionKey(actorWorldPosition(state.actors.moss)),
    positionKey(actorWorldPosition(state.actors.rill)),
    positionKey(state.actors.rill.movement.to),
  ]);

  assert.equal(applyFormation(state, "cinder", formationAction({
    generation: 2,
    formation_id: "occupied-center",
    closed: false,
    path_tiles: [{ x: -1, y: 0 }, { x: 1, y: 0 }],
    region_index: 0,
    region_count: 1,
    members: ["cinder"],
  })).accepted, true);

  advanceUntil(state, () => (
    state.actors.cinder.movement === undefined
    && state.actors.cinder.activity.startsWith("holding formation")
  ), 500);
  assert.equal(forbidden.has(positionKey(actorWorldPosition(state.actors.cinder))), false);
  assert.ok(state.actors.cinder.formationConstraint);
});

test("retained formations execute accepted say, emote, and non-positional random choices", () => {
  const state = formationWorld(["cinder"]);
  assert.equal(applyFormation(state, "cinder", formationAction({
    generation: 3,
    formation_id: "speaking-post",
    closed: false,
    path_tiles: [{ x: -2, y: 2 }, { x: 2, y: 2 }],
    region_index: 0,
    region_count: 1,
    members: ["cinder"],
  })).accepted, true);
  advanceUntil(state, () => state.actors.cinder.activity.startsWith("holding formation"), 500);

  assert.equal(applyWorldToolAction(state, {
    actionId: "formation-say",
    requestId: "formation-say-turn",
    agentId: "cinder",
    action: { kind: "say", text: "The line is steady." },
  }).accepted, true);
  updateWorld(state, 100);
  assert.equal(state.actors.cinder.bubble?.text, "The line is steady.");
  assert.ok(state.actors.cinder.formationConstraint);

  assert.equal(applyWorldToolAction(state, {
    actionId: "formation-emote",
    requestId: "formation-emote-turn",
    agentId: "cinder",
    action: { kind: "emote", icon: "spark" },
  }).accepted, true);
  updateWorld(state, 100);
  assert.equal(state.actors.cinder.emote?.icon, "spark");
  assert.ok(state.actors.cinder.formationConstraint);

  assert.equal(applyWorldToolAction(state, {
    actionId: "formation-random",
    requestId: "formation-random-turn",
    agentId: "cinder",
    action: {
      kind: "random_choice",
      chance_percent: 100,
      true_label: "signal",
      false_label: "wait",
      if_true: [{ kind: "say", text: "Signal chosen." }],
      if_false: [{ kind: "emote", icon: "?" }],
    },
  }).accepted, true);
  updateWorld(state, 100);
  updateWorld(state, 100);
  assert.ok(state.activities.some(({ text }) => text === "Cinder's random choice was signal."));
  assert.equal(state.actors.cinder.bubble?.text, "Signal chosen.");
  assert.ok(state.actors.cinder.formationConstraint);
});

test("every reciprocal formation action must match one canonical fingerprint", async (t) => {
  const mismatches: readonly Readonly<{
    name: string;
    mutate: (action: FormationAction) => FormationAction;
  }>[] = [
    { name: "reciprocal members", mutate: (action) => ({ ...action, members: ["moss", "rill"] }) },
    { name: "anchor", mutate: (action) => ({ ...action, anchor: "rill" }) },
    { name: "closed", mutate: (action) => ({ ...action, closed: false }) },
    {
      name: "exact path",
      mutate: (action) => ({ ...action, path_tiles: [{ x: -3, y: -2 }, { x: 3, y: -2 }] }),
    },
    { name: "region count", mutate: (action) => ({ ...action, region_count: 1, region_index: 0 }) },
    { name: "valid region index", mutate: (action) => ({ ...action, region_index: action.region_count }) },
  ];

  for (const mismatch of mismatches) {
    await t.test(mismatch.name, () => {
      const state = formationWorld(["cinder", "moss", "rill"]);
      const first = formationAction({
        generation: 4,
        formation_id: `fingerprint-${mismatch.name}`,
        closed: true,
        path_tiles: [{ x: -3, y: -3 }, { x: 3, y: 3 }],
        region_index: 0,
        region_count: 2,
        members: ["cinder", "moss"],
      });
      assert.equal(applyFormation(state, "cinder", first).accepted, true);
      const conflicting = mismatch.mutate({ ...first, region_index: 1 });
      assert.deepEqual(applyFormation(state, "moss", conflicting), {
        accepted: false,
        reason: "invalid",
      });
      assert.equal(state.actors.cinder.formationConstraint, undefined);
      assert.equal(state.actors.moss.formationConstraint, undefined);
    });
  }
});

test("formation waves require capacity-clearing region claims", () => {
  const state = formationWorld(["cinder", "moss", "rill"]);
  const pending = [];
  for (const id of ["cinder", "moss", "rill"] as const) {
    const application = applyFormation(state, id, formationAction({
      generation: 5,
      formation_id: "imbalanced-regions",
      path_tiles: [{ x: -6, y: 0 }, { x: 6, y: 0 }],
      region_index: 0,
      region_count: 2,
      members: ["cinder", "moss", "rill"],
    }));
    assert.equal(application.accepted, true);
    if (application.accepted) pending.push(application.pending);
  }
  updateWorld(state, 16);
  assert.ok(["cinder", "moss", "rill"].every((id) => (
    state.actors[id].formationConstraint === undefined
  )));
  assert.ok(pending.every((action) => (
    worldToolResultAtDecisionBoundary(state, action)?.outcome.status === "rejected"
  )));
});

test("formation tool calls report in-progress only at the control horizon", () => {
  const state = formationWorld(["cinder"]);
  relocate(state, "cinder", "town", 12, 13);
  const application = applyFormation(state, "cinder", formationAction({
    generation: 6,
    formation_id: "decision-horizon",
    path_tiles: [{ x: 10, y: 10 }, { x: 12, y: 10 }],
  }));
  assert.equal(application.accepted, true);
  if (!application.accepted) return;
  assert.equal(worldToolResultAtDecisionBoundary(state, application.pending), undefined);
  for (let tick = 0; tick < 12; tick += 1) updateWorld(state, 100);
  assert.equal(worldToolResultAtDecisionBoundary(state, application.pending)?.outcome.status, "in_progress");
});

test("a settled circle can re-form at approximately double its prior radius", () => {
  const members = RESIDENT_IDS.slice(0, 8);
  const state = formationWorld(members);
  relocate(state, "player", "town", 16, 13);
  members.forEach((residentId, index) => relocate(state, residentId, "town", 12 + index, 13));
  const circle = (radius: number) => {
    const diagonal = Math.round(radius / Math.sqrt(2));
    return [
      { x: radius, y: 0 }, { x: diagonal, y: diagonal },
      { x: 0, y: radius }, { x: -diagonal, y: diagonal },
      { x: -radius, y: 0 }, { x: -diagonal, y: -diagonal },
      { x: 0, y: -radius }, { x: diagonal, y: -diagonal },
    ] as const;
  };
  const run = (generation: number, radius: number) => {
    members.forEach((residentId) => assert.equal(applyWorldToolAction(state, {
      actionId: `scaling-circle-${generation}-${residentId}`,
      requestId: `scaling-circle-${generation}-${residentId}-turn`,
      agentId: residentId,
      action: formationAction({
        generation,
        formation_id: "scaling-circle",
        path_tiles: circle(radius),
        region_index: 0,
        region_count: 1,
        members,
      }),
    }).accepted, true));
    advanceUntil(state, () => members.every((residentId) => (
      state.actors[residentId].movement === undefined
      && state.actors[residentId].activity.startsWith("holding formation")
    )), 1_000);
    const anchor = actorWorldPosition(state.actors.player);
    return members.reduce((sum, residentId) => (
      sum + Math.hypot(
        state.actors[residentId].x - anchor.x,
        state.actors[residentId].y - anchor.y,
      )
    ), 0) / members.length;
  };

  const original = run(9, 3);
  const doubled = run(10, 6);
  assert.ok(doubled / original > 1.8, `${original} did not approximately double to ${doubled}`);
  assert.ok(doubled / original < 2.2, `${original} more than doubled to ${doubled}`);
});

test("a full swarm keeps its arc claims across repeated control-horizon polls", () => {
  const state = formationWorld(RESIDENT_IDS);
  const members = [...RESIDENT_IDS];
  const path = [
    { x: 0, y: -8 }, { x: 6, y: -6 }, { x: 8, y: 0 }, { x: 6, y: 6 },
    { x: 0, y: 8 }, { x: -6, y: 6 }, { x: -8, y: 0 }, { x: -6, y: -6 },
  ] as const;
  let wave = 0;
  const submit = (residentId: ResidentId, index: number) => applyWorldToolAction(state, {
    actionId: `stable-arc-${residentId}-${wave}`,
    requestId: `stable-arc-turn-${residentId}-${wave}`,
    agentId: residentId,
    action: formationAction({
      generation: 7,
      formation_id: "stable-arc-circle",
      path_tiles: path,
      region_index: index % 8,
      region_count: 8,
      members,
    }),
  });
  members.forEach((residentId, index) => assert.equal(submit(residentId, index).accepted, true));

  let settled = false;
  let mostHolding = 0;
  for (let tick = 0; tick < 1_500 && !settled; tick += 1) {
    updateWorld(state, 100);
    mostHolding = Math.max(mostHolding, members.filter((residentId) => (
      state.actors[residentId].movement === undefined
      && state.actors[residentId].activity.startsWith("holding formation")
    )).length);
    settled = members.every((residentId) => (
      state.actors[residentId].movement === undefined
      && state.actors[residentId].activity.startsWith("holding formation")
    ));
    if (settled) break;
    if (state.elapsedMs % 1_200 === 0) {
      wave += 1;
      members.forEach((residentId, index) => {
        if (!state.actors[residentId].activity.startsWith("holding formation")) {
          assert.equal(submit(residentId, index).accepted, true);
        }
      });
    }
  }
  assert.equal(settled, true, `formation stalled with at most ${mostHolding}/48 holding:\n${members
    .filter((residentId) => !state.actors[residentId].activity.startsWith("holding formation"))
    .map((residentId) => `${residentId}: ${state.actors[residentId].activity}`)
    .join("\n")}`);
});

test("formation completion is one atomic reducer snapshot after a stable hold", () => {
  const state = formationWorld(["cinder"]);
  relocate(state, "player", "town", 16, 13);
  relocate(state, "cinder", "town", 12, 13);
  const application = applyWorldToolAction(state, {
    actionId: "atomic-hold-cinder",
    requestId: "atomic-hold-turn",
    agentId: "cinder",
    action: formationAction({
      generation: 11,
      formation_id: "atomic-hold",
      path_tiles: [{ x: 2, y: 0 }, { x: 3, y: 0 }],
    }),
  });
  assert.equal(application.accepted, true);
  if (!application.accepted) return;

  advanceUntil(state, () => state.actors.cinder.activity.startsWith("holding formation"), 500);
  const provisional = formationSnapshotFor(state, 11);
  assert.equal(provisional.waves.length, 1);
  assert.equal(provisional.waves[0].status, "forming");
  assert.deepEqual(provisional.waves[0].unresolvedMembers, ["cinder"]);
  assert.equal(
    worldToolResultAtDecisionBoundary(state, application.pending, 0)?.outcome.status,
    "in_progress",
  );

  for (let tick = 0; tick < 4; tick += 1) updateWorld(state, 100);
  const held = formationSnapshotFor(state, 11);
  assert.equal(held.waves[0].status, "holding");
  assert.deepEqual(held.waves[0].unresolvedMembers, []);
  const result = worldToolResultAtDecisionBoundary(state, application.pending, 0);
  assert.equal(result?.outcome.status, "completed");
  assert.deepEqual(result?.formationSnapshot, held);
});

test("a congested swarm converges from a wide ring into a compact square and stays put", () => {
  const members = RESIDENT_IDS.slice(0, 8);
  const state = formationWorld(members);
  relocate(state, "player", "town", 16, 13);
  members.forEach((residentId, index) => relocate(state, residentId, "town", 12 + index, 13));
  const submit = (
    generation: number,
    formationId: string,
    path: FormationAction["path_tiles"],
  ) => members.forEach((residentId, index) => {
    const application = applyWorldToolAction(state, {
      actionId: `${formationId}-${residentId}`,
      requestId: `${formationId}-${residentId}-turn`,
      agentId: residentId,
      action: formationAction({
        generation,
        formation_id: formationId,
        path_tiles: path,
        region_index: index,
        region_count: members.length,
        members,
      }),
    });
    assert.equal(application.accepted, true);
  });

  submit(12, "wide-ring", [
    { x: 0, y: -6 }, { x: 4, y: -4 }, { x: 6, y: 0 }, { x: 4, y: 4 },
    { x: 0, y: 6 }, { x: -4, y: 4 }, { x: -6, y: 0 }, { x: -4, y: -4 },
  ]);
  advanceUntil(state, () => formationSnapshotFor(state, 12).waves[0]?.status === "holding", 1_000);

  submit(13, "compact-square", [
    { x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 },
  ]);
  advanceUntil(state, () => formationSnapshotFor(state, 13).waves[0]?.status === "holding", 1_000);
  const settled = new Map(members.map((residentId) => [residentId, actorWorldPosition(state.actors[residentId])]));
  for (let tick = 0; tick < 12; tick += 1) updateWorld(state, 100);
  assert.deepEqual(
    new Map(members.map((residentId) => [residentId, actorWorldPosition(state.actors[residentId])])),
    settled,
  );
  assert.equal(new Set([...settled.values()].map(positionKey)).size, members.length);
});

test("a common-idle slot permutation settles by rebinding ownership without movement", () => {
  const state = formationWorld(["cinder", "moss"]);
  relocate(state, "player", "town", 16, 13);
  const members = ["cinder", "moss"] as const;
  members.forEach((residentId, regionIndex) => {
    const application = applyWorldToolAction(state, {
      actionId: `slot-permutation-${residentId}`,
      requestId: `slot-permutation-${residentId}-turn`,
      agentId: residentId,
      action: formationAction({
        generation: 14,
        formation_id: "slot-permutation",
        closed: false,
        path_tiles: [{ x: -2, y: 0 }, { x: 2, y: 0 }],
        region_index: regionIndex,
        region_count: 2,
        members,
      }),
    });
    assert.equal(application.accepted, true);
  });
  const cinderConstraint = state.actors.cinder.formationConstraint;
  const mossConstraint = state.actors.moss.formationConstraint;
  assert.ok(cinderConstraint && mossConstraint);
  Object.assign(cinderConstraint, { targetOffset: { x: -2, y: 1 }, targetArc: 0, slotsRematched: true });
  Object.assign(mossConstraint, { targetOffset: { x: 2, y: 1 }, targetArc: 4, slotsRematched: true });
  relocate(state, "cinder", "town", 18, 14);
  relocate(state, "moss", "town", 14, 14);

  updateWorld(state, 100);
  assert.deepEqual(actorWorldPosition(state.actors.cinder), { scene: "town", x: 18, y: 14 });
  assert.deepEqual(actorWorldPosition(state.actors.moss), { scene: "town", x: 14, y: 14 });
  assert.deepEqual(state.actors.cinder.formationConstraint?.targetOffset, { x: 2, y: 1 });
  assert.deepEqual(state.actors.moss.formationConstraint?.targetOffset, { x: -2, y: 1 });
  for (let tick = 0; tick < 4; tick += 1) updateWorld(state, 100);
  assert.equal(formationSnapshotFor(state, 14).waves[0].status, "holding");
});

function formationAction(overrides: Partial<FormationAction>): FormationAction {
  return {
    kind: "maintain_formation",
    generation: 1,
    formation_id: "formation",
    anchor: "player",
    closed: true,
    path_tiles: [{ x: -2, y: -2 }, { x: 2, y: 2 }],
    region_index: 0,
    region_count: 1,
    members: ["cinder"],
    ...overrides,
  };
}

function applyFormation(state: WorldState, agentId: ResidentId, action: FormationAction) {
  return applyWorldToolAction(state, {
    actionId: `${action.formation_id}-${agentId}`,
    requestId: `${action.formation_id}-${agentId}-turn`,
    agentId,
    action,
  });
}

function formationWorld(active: readonly ResidentId[]): WorldState {
  const state = createWorldState();
  setWorldAgentsOnline(state, true);
  for (const id of RESIDENT_IDS) {
    state.actors[id].presence = active.includes(id) ? "active" : "absent";
    state.actors[id].tasks = [];
    state.actors[id].movement = undefined;
  }
  return state;
}

function relocate(
  state: WorldState,
  actorId: ResidentId | "player",
  scene: "town" | "guild_hall" | "trail_shop",
  x: number,
  y: number,
): void {
  Object.assign(state.actors[actorId], { scene, x, y, movement: undefined });
}

function advanceUntil(state: WorldState, condition: () => boolean, maximumTicks: number): void {
  for (let tick = 0; tick < maximumTicks; tick += 1) {
    updateWorld(state, 100);
    if (condition()) return;
  }
  assert.fail(`world did not reach the expected state within ${maximumTicks} ticks`);
}

function positionKey(position: { scene: string; x: number; y: number }): string {
  return `${position.scene}:${position.x},${position.y}`;
}
