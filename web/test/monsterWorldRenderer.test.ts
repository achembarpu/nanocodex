import assert from "node:assert/strict";
import test from "node:test";

import {
  WORLD_PIXEL_HEIGHT,
  WORLD_PIXEL_WIDTH,
} from "../src/monsterWorldMap.ts";
import { drawMonsterWorld } from "../src/monsterWorldRenderer.ts";
import { createWorldState } from "../src/monsterWorldSimulation.ts";

test("the renderer draws the town and both interiors into the fixed logical viewport", () => {
  const { context, canvas, labels, operations } = recordingContext();
  const state = createWorldState();

  for (const [scene, x, y, label, foreground, cameraTransform] of [
    ["town", 62, 46, "SPRINGLEAF DISTRICT", "fillRect(38,48,28,4)", "translate(-256,-192)"],
    ["guild_hall", 16, 11, "RESCUE GUILD HALL", "fillRect(104,46,56,4)", "translate(0,0)"],
    ["trail_shop", 16, 10, "TRAIL SHOP", "fillRect(88,62,88,4)", "translate(0,0)"],
  ] as const) {
    const player = state.actors.player;
    player.scene = scene;
    player.x = x;
    player.y = y;
    player.movement = undefined;
    labels.length = 0;
    operations.length = 0;

    assert.doesNotThrow(() => {
      drawMonsterWorld(context, state, undefined, { reducedMotion: false });
    });
    assert.equal(canvas.width, WORLD_PIXEL_WIDTH);
    assert.equal(canvas.height, WORLD_PIXEL_HEIGHT);
    assert.ok(labels.includes(label), `${scene} plaque`);
    assert.ok(operations.includes(foreground), `${scene} foreground`);
    assert.equal(
      operations.filter((operation) => operation === cameraTransform).length,
      2,
      `${scene} background and foreground camera transforms`,
    );
  }
});

function recordingContext(): Readonly<{
  context: CanvasRenderingContext2D;
  canvas: { width: number; height: number };
  labels: string[];
  operations: string[];
}> {
  const canvas = { width: 0, height: 0 };
  const labels: string[] = [];
  const operations: string[] = [];
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    measureText: (text) => ({ width: String(text).length * 3 }),
    fillText: (text) => labels.push(String(text)),
    fillRect: (...args) => operations.push(`fillRect(${args.join(",")})`),
    translate: (...args) => operations.push(`translate(${args.join(",")})`),
  };
  const context = new Proxy({ canvas } as unknown as CanvasRenderingContext2D, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (typeof property !== "string") return undefined;
      methods[property] ??= () => undefined;
      return methods[property];
    },
    set(target, property, value, receiver) {
      return Reflect.set(target, property, value, receiver);
    },
  });
  return { context, canvas, labels, operations };
}
