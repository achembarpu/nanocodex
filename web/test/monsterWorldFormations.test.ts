import assert from "node:assert/strict";
import test from "node:test";

import {
  WORLD_FORMATION_KINDS,
  WORLD_FORMATION_LADDER,
  formationKindForPrompt,
  formationOffset,
  formationPathGroups,
} from "../src/monsterWorldFormations.ts";
import { isWorldPositionBlocked } from "../src/monsterWorldMap.ts";
import { RESIDENT_IDS } from "../src/monsterWorldProtocol.ts";
import { actorWorldPosition, createWorldState } from "../src/monsterWorldSimulation.ts";

test("the formation ladder grows from simple outlines to two-ring coordination", () => {
  assert.deepEqual(WORLD_FORMATION_LADDER.map(({ kind }) => kind), WORLD_FORMATION_KINDS);
  for (const preset of WORLD_FORMATION_LADDER) {
    assert.ok(preset.prompt.length <= 140, `${preset.kind} exceeds the World speech boundary`);
    assert.equal(formationKindForPrompt(preset.prompt), preset.kind);
    assert.match(preset.prompt, /evenly/i);
    assert.match(preset.prompt, /no gaps/i);
    assert.match(preset.prompt, /correct blocked movement/i);
  }
  assert.equal(formationKindForPrompt("Meet Scout at the bridge."), undefined);
});

test("all 36 default residents receive unique, tile-aligned, initially walkable formation slots", () => {
  const player = actorWorldPosition(createWorldState().actors.player);
  for (const kind of WORLD_FORMATION_KINDS) {
    const positions = RESIDENT_IDS.slice(0, 36).map((_, index) => {
      const offset = formationOffset(kind, index, 36);
      assert.equal(Math.abs(offset.dxPixels % 8), 0, `${kind}-${index}-x`);
      assert.equal(Math.abs(offset.dyPixels % 8), 0, `${kind}-${index}-y`);
      const position = {
        scene: player.scene,
        x: player.x + offset.dxPixels / 8,
        y: player.y + offset.dyPixels / 8,
      } as const;
      assert.equal(isWorldPositionBlocked(position), false, `${kind}-${index}`);
      return position;
    });
    assert.equal(
      new Set(positions.map(({ scene, x, y }) => `${scene}:${x}:${y}`)).size,
      positions.length,
      kind,
    );
    assert.equal(
      formationPathGroups(kind, positions.length).flatMap(({ indexes }) => indexes).length,
      positions.length,
      kind,
    );
  }
});
