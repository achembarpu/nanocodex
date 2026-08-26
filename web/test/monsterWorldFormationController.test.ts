import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRegionMarket,
  composeFormationPath,
  compileFormation,
  createTilePolyline,
  deriveDensityTargets,
  measureFormation,
  partitionTilePolyline,
  planJointGridTick,
  projectOntoTilePolyline,
  sampleTilePolyline,
  type FormationResident,
  type RegionClaim,
  type TilePoint,
} from "../src/monsterWorldFormationController.ts";

const p = (x: number, y: number): TilePoint => ({ x, y });
const distance = (from: TilePoint, to: TilePoint) => Math.abs(from.x - to.x) + Math.abs(from.y - to.y);

test("local component contours compose over arbitrary outer layout paths", () => {
  const square = [p(-2, -2), p(2, -2), p(2, 2), p(-2, 2)];
  const ring = polygon(0, 0, 20, 12);
  const components = Array.from({ length: 6 }, (_, index) => composeFormationPath(square, {
    points: ring,
    closed: true,
    index,
    count: 6,
  }));
  const centers = components.map((points) => p(
    points.reduce((sum, point) => sum + point.x, 0) / points.length,
    points.reduce((sum, point) => sum + point.y, 0) / points.length,
  ));
  assert.equal(new Set(centers.map(({ x, y }) => `${x},${y}`)).size, 6);
  assert.ok(centers.every(({ x, y }) => Math.abs(Math.hypot(x, y) - 20) < 1));
  assert.ok(components.every((points) => (
    Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x)) === 4
    && Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y)) === 4
  )));

  assert.deepEqual(composeFormationPath(square, {
    points: [p(100, 0), p(0, 100), p(-100, 0), p(0, -100)],
    closed: true,
    index: 0,
    count: 4,
  }), [p(98, -2), p(102, -2), p(102, 2), p(98, 2)]);
});

test("open and closed polylines sample and project by arc length in world tiles", () => {
  const open = createTilePolyline([p(0, 0), p(6, 0), p(6, 8)]);
  assert.equal(open.length, 14);
  assert.deepEqual(sampleTilePolyline(open, 9), p(6, 3));
  assert.deepEqual(sampleTilePolyline(open, 99), p(6, 8));
  assert.deepEqual(projectOntoTilePolyline(open, p(4, 3)), {
    point: p(6, 3), arc: 9, normalizedArc: 9 / 14, distance: 2,
  });

  const closed = createTilePolyline([p(0, 0), p(4, 0), p(4, 4), p(0, 4)], true);
  assert.equal(closed.length, 16);
  assert.deepEqual(sampleTilePolyline(closed, 18), p(2, 0));
  assert.deepEqual(sampleTilePolyline(closed, 14), p(0, 2));
});

test("balanced region capacities are bounded and contiguous", () => {
  const path = createTilePolyline([p(0, 0), p(100, 0)]);
  const regions = partitionTilePolyline(path, 17, 6);
  assert.deepEqual(regions.map(({ capacity }) => capacity), [3, 3, 3, 3, 3, 2]);
  assert.equal(regions[0].startArc, 0);
  assert.equal(regions.at(-1)?.endArc, 100);
  for (let index = 1; index < regions.length; index += 1) {
    assert.equal(regions[index - 1].endArc, regions[index].startArc);
  }
});

test("market claims are permutation-stable, capacity-clearing, and travel-sensitive", () => {
  const path = createTilePolyline([p(0, 0), p(100, 0)]);
  const regions = partitionTilePolyline(path, 4, 2);
  const residents = [resident("d", 99, 0), resident("a", 1, 0), resident("c", 80, 0), resident("b", 20, 0)];
  const run = (input: typeof residents) => clearRegionMarket(input, regions, {
    generation: 1,
    congestionWeight: 3,
  }).map(({ residentId, regionIndex }) => [residentId, regionIndex]);
  assert.deepEqual(run(residents), run([...residents].reverse()));
  assert.deepEqual(run(residents), [["a", 0], ["b", 0], ["c", 1], ["d", 1]]);
});

test("component bids use contour distance for concentric neighborhoods", () => {
  const inner = createTilePolyline(polygon(0, 0, 10, 24), true);
  const outer = createTilePolyline(polygon(0, 0, 30, 32), true);
  const regions = [inner, outer].map((path, index) => ({
    index,
    startArc: 0,
    endArc: path.length,
    capacity: 2,
    center: p(0, 0),
  }));
  const residents = [
    resident("inner-a", 9, 0),
    resident("outer-a", 29, 0),
    resident("inner-b", -9, 0),
    resident("outer-b", -29, 0),
  ];
  const run = (input: typeof residents) => clearRegionMarket(input, regions, {
    generation: 1,
    routeDistance(from, _center, _residentId, region) {
      return projectOntoTilePolyline([inner, outer][region.index], from).distance;
    },
  }).map(({ residentId, regionIndex }) => [residentId, regionIndex]);
  assert.deepEqual(run(residents), run([...residents].reverse()));
  assert.deepEqual(run(residents), [
    ["inner-a", 0],
    ["inner-b", 0],
    ["outer-a", 1],
    ["outer-b", 1],
  ]);
});

test("claim retention applies only to the exact generation", () => {
  const path = createTilePolyline([p(0, 0), p(20, 0)]);
  const regions = partitionTilePolyline(path, 2, 2);
  const residents = [resident("a", 9, 0), resident("b", 11, 0)];
  const prior = new Map<string, RegionClaim<number>>([
    ["a", { generation: 7, regionIndex: 1 }],
    ["b", { generation: 7, regionIndex: 0 }],
  ]);
  const retained = clearRegionMarket(residents, regions, {
    generation: 7, previousClaims: prior, retentionBonus: 10,
  });
  assert.deepEqual(retained.map(({ residentId, regionIndex }) => [residentId, regionIndex]), [["a", 1], ["b", 0]]);
  const nextGeneration = clearRegionMarket(residents, regions, {
    generation: 8, previousClaims: prior, retentionBonus: 10,
  });
  assert.deepEqual(nextGeneration.map(({ residentId, regionIndex }) => [residentId, regionIndex]), [["a", 0], ["b", 1]]);
});

test("dense residents spread around a closed curve using temporary locality targets", () => {
  const circle = polygon(0, 0, 20, 32);
  const residents = Array.from({ length: 24 }, (_, index) => resident(`r${String(index).padStart(2, "0")}`, 18 - index % 3, index % 4));
  const compiled = compileFormation({ points: circle, closed: true, residents, generation: "circle", maxRegions: 1 });
  const metrics = measureFormation(compiled.path, compiled.targets.map(({ target }) => target));
  assert.ok(metrics.meanCurveDistance < 0.75);
  assert.ok(metrics.maxNormalizedArcGap < 0.07);
  assert.equal(new Set(compiled.targets.map(({ target }) => `${target.x},${target.y}`)).size, residents.length);

  const orderBefore = [...residents]
    .sort((a, b) => projectOntoTilePolyline(compiled.path, a.position).arc - projectOntoTilePolyline(compiled.path, b.position).arc)
    .map(({ id }) => id);
  const orderAfter = [...compiled.targets]
    .sort((a, b) => a.targetArc - b.targetArc)
    .map(({ residentId }) => residentId);
  assert.deepEqual(cyclicCanonical(orderAfter), cyclicCanonical(orderBefore));
});

test("arbitrary star polylines compile without shape-specific behavior", () => {
  const star = starPoints(30, 30, 24, 9);
  const residents = Array.from({ length: 17 }, (_, index) => resident(`s${index}`, index, 60 - index));
  const compiled = compileFormation({ points: star, closed: true, residents, generation: 1, maxRegions: 5 });
  assert.equal(compiled.targets.length, residents.length);
  assert.equal(compiled.regions.length, 5);
  assert.deepEqual(compiled.regions.map(({ capacity }) => capacity), [4, 4, 3, 3, 3]);
  assert.ok(compiled.targets.every(({ target }) => Number.isInteger(target.x) && Number.isInteger(target.y)));
});

test("two agents avoid a direct swap by taking a deterministic safe detour", () => {
  const plan = planJointGridTick([
    { id: "a", position: p(0, 0), target: p(1, 0) },
    { id: "b", position: p(1, 0), target: p(0, 0) },
  ], { isBlocked: () => false, routeDistance: distance });
  const destinations = new Set(plan.moves.map(({ to }) => `${to.x},${to.y}`));
  assert.equal(destinations.size, 2);
  assert.ok(plan.moves.some(({ to }) => to.y !== 0));
  assert.equal(plan.moves.some(({ residentId, to }) => residentId === "a" && to.x === 1 && to.y === 0)
    && plan.moves.some(({ residentId, to }) => residentId === "b" && to.x === 0 && to.y === 0), false);
});

test("a safe cardinal four-cycle commits atomically", () => {
  const plan = planJointGridTick([
    { id: "a", position: p(0, 0), target: p(1, 0) },
    { id: "b", position: p(1, 0), target: p(1, 1) },
    { id: "c", position: p(1, 1), target: p(0, 1) },
    { id: "d", position: p(0, 1), target: p(0, 0) },
  ], { isBlocked: () => false, routeDistance: distance });
  assert.ok(plan.moves.every(({ moved, to }, index) => moved && to.x === [1, 1, 0, 0][index] && to.y === [0, 1, 1, 0][index]));
  assert.deepEqual(plan.blocked, []);
});

test("an impossible full corridor stays put and reports blocked wait ages", () => {
  const plan = planJointGridTick([
    { id: "a", position: p(0, 0), target: p(3, 0), waitAge: 2 },
    { id: "b", position: p(1, 0), target: p(3, 0) },
    { id: "c", position: p(2, 0), target: p(3, 0), waitAge: 1 },
  ], {
    isBlocked: ({ x, y }) => y !== 0 || x < 0 || x > 2,
    routeDistance: distance,
  });
  assert.ok(plan.moves.every(({ moved }) => !moved));
  assert.deepEqual(plan.blocked, ["a", "b", "c"]);
  assert.deepEqual([...plan.nextWaitAges], [["a", 3], ["b", 1], ["c", 2]]);
});

test("circle to six squares to star recompiles repeatedly from live prior positions", () => {
  const ids = Array.from({ length: 48 }, (_, index) => `r${String(index).padStart(2, "0")}`);
  let live = ids.map((id, index) => resident(id, index % 8, Math.floor(index / 8)));
  let claims: ReadonlyMap<string, RegionClaim<number>> | undefined;
  const shapes = [
    polygon(40, 40, 24, 32),
    sixSquares(),
    starPoints(40, 40, 28, 11),
  ];
  for (let generation = 0; generation < 6; generation += 1) {
    const points = shapes[generation % shapes.length];
    const compiled = compileFormation({
      points,
      closed: true,
      residents: live,
      generation,
      previousClaims: claims,
      maxRegions: 6,
    });
    assert.equal(compiled.targets.length, 48);
    assert.equal(new Set(compiled.targets.map(({ residentId }) => residentId)).size, 48);
    assert.ok(compiled.targets.every(({ target }) => Number.isInteger(target.x) && Number.isInteger(target.y)));
    live = compiled.targets.map(({ residentId, target }) => ({ id: residentId, position: target }));
    claims = compiled.claims;
  }
});

function resident(id: string, x: number, y: number): FormationResident {
  return { id, position: p(x, y) };
}

function polygon(cx: number, cy: number, radius: number, count: number): TilePoint[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = 2 * Math.PI * index / count;
    return p(Math.round(cx + radius * Math.cos(angle)), Math.round(cy + radius * Math.sin(angle)));
  });
}

function starPoints(cx: number, cy: number, outer: number, inner: number): TilePoint[] {
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + Math.PI * index / 5;
    const radius = index % 2 === 0 ? outer : inner;
    return p(Math.round(cx + radius * Math.cos(angle)), Math.round(cy + radius * Math.sin(angle)));
  });
}

function sixSquares(): TilePoint[] {
  return Array.from({ length: 6 }, (_, index) => {
    const x = 8 + index % 3 * 28;
    const y = 18 + Math.floor(index / 3) * 36;
    return [p(x, y), p(x + 12, y), p(x + 12, y + 12), p(x, y + 12)];
  }).flat();
}

function cyclicCanonical(values: readonly string[]): readonly string[] {
  let best = [...values];
  for (let offset = 1; offset < values.length; offset += 1) {
    const candidate = [...values.slice(offset), ...values.slice(0, offset)];
    if (candidate.join("\0") < best.join("\0")) best = candidate;
  }
  return best;
}
