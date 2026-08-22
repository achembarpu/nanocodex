import assert from "node:assert/strict";
import test from "node:test";
import {
  WORLD_ENTRY_PORTALS,
  WORLD_PIXEL_HEIGHT,
  WORLD_PIXEL_WIDTH,
  WORLD_POIS,
  WORLD_PORTALS,
  WORLD_SCENES,
  WORLD_VIEW_COLUMNS,
  WORLD_VIEW_ROWS,
  cameraForPosition,
  findWorldRoute,
  isWorldPositionBlocked,
  isWorldPositionInBounds,
  portalDestinationAt,
  viewportToWorld,
  worldToViewport,
} from "../src/monsterWorldMap.ts";
import type { WorldPosition } from "../src/monsterWorldProtocol.ts";

test("expanded scenes retain the pixel viewport and expose walkable landmarks", () => {
  assert.equal(WORLD_VIEW_COLUMNS, 32);
  assert.equal(WORLD_VIEW_ROWS, 24);
  assert.equal(WORLD_PIXEL_WIDTH, 256);
  assert.equal(WORLD_PIXEL_HEIGHT, 192);
  assert.deepEqual(
    [WORLD_SCENES.town.columns, WORLD_SCENES.town.rows],
    [64, 48],
  );
  assert.ok(WORLD_SCENES.town.columns * WORLD_SCENES.town.rows >= 4 * 32 * 24);
  assert.equal(WORLD_SCENES.guild_hall.indoors, true);
  assert.equal(WORLD_SCENES.trail_shop.indoors, true);

  for (const landmark of Object.values(WORLD_POIS)) {
    assert.equal(isWorldPositionInBounds(landmark), true, landmark.label);
    assert.equal(isWorldPositionBlocked(landmark), false, landmark.label);
  }
  assert.equal(WORLD_ENTRY_PORTALS.length, 48);
  for (const entry of WORLD_ENTRY_PORTALS) {
    assert.equal(isWorldPositionInBounds(entry.inside), true);
    assert.equal(isWorldPositionBlocked(entry.inside), false);
  }
});

test("guild and shop doors are paired, walkable, and do not bounce on arrival", () => {
  assert.equal(WORLD_PORTALS.length, 4);
  for (const worldPortal of WORLD_PORTALS) {
    const pair = WORLD_PORTALS.find(({ id }) => id === worldPortal.pairId);
    assert.ok(pair, worldPortal.id);
    assert.equal(pair.pairId, worldPortal.id);
    assert.equal(isWorldPositionBlocked(worldPortal.from), false);
    assert.equal(isWorldPositionBlocked(worldPortal.to), false);
    assert.deepEqual(portalDestinationAt(worldPortal.from), worldPortal.to);
    assert.equal(portalDestinationAt(worldPortal.to), undefined, `${worldPortal.id} arrival bounces`);
  }
});

test("deterministic routes reach every landmark and cross both room boundaries", () => {
  const start = WORLD_POIS.plaza;
  for (const [target, landmark] of Object.entries(WORLD_POIS)) {
    const route = findWorldRoute(start, landmark);
    if (target === "plaza") {
      assert.deepEqual(route, []);
    } else {
      assert.ok(route.length > 0, target);
      assert.deepEqual(route.at(-1), {
        scene: landmark.scene,
        x: landmark.x,
        y: landmark.y,
      });
    }
  }

  const guildRoute = findWorldRoute(start, WORLD_POIS.guild);
  assert.ok(guildRoute.some(({ scene }) => scene === "guild_hall"));
  assert.ok(guildRoute.some((step, index) => index > 0 && step.scene !== guildRoute[index - 1]?.scene));
  assert.deepEqual(findWorldRoute(start, WORLD_POIS.guild), guildRoute);

  const shopToGuild = findWorldRoute(WORLD_POIS.shop, WORLD_POIS.mission_board);
  assert.ok(shopToGuild.some(({ scene }) => scene === "town"));
  assert.ok(shopToGuild.some(({ scene }) => scene === "guild_hall"));
});

test("camera clamps at town corners and pointer conversion shares its origin", () => {
  assert.deepEqual(cameraForPosition(pos("town", 1, 2)), { scene: "town", x: 0, y: 0 });
  assert.deepEqual(cameraForPosition(pos("town", 62, 46)), { scene: "town", x: 32, y: 24 });
  assert.deepEqual(cameraForPosition(pos("guild_hall", 16, 20)), {
    scene: "guild_hall",
    x: 0,
    y: 0,
  });

  const camera = cameraForPosition(pos("town", 44, 32));
  const world = pos("town", 47, 35);
  const viewport = worldToViewport(camera, world);
  assert.ok(viewport);
  assert.deepEqual(
    viewportToWorld(camera, viewport.x + 4, viewport.y + 4),
    world,
  );
  assert.equal(worldToViewport(camera, pos("trail_shop", 16, 10)), undefined);
});

test("unknown scenes are out of bounds instead of throwing", () => {
  const unknownScene = { scene: "the_void", x: 0, y: 0 } as unknown as WorldPosition;
  assert.equal(isWorldPositionInBounds(unknownScene), false);
  assert.equal(isWorldPositionBlocked(unknownScene), true);
});

function pos(scene: WorldPosition["scene"], x: number, y: number): WorldPosition {
  return { scene, x, y };
}
