import assert from "node:assert/strict";
import test from "node:test";

import {
  compileFormation,
  measureFormation,
  type FormationCompilation,
  type FormationResident,
  type TilePoint,
} from "../src/monsterWorldFormationController.ts";

const p = (x: number, y: number): TilePoint => ({ x, y });
const pointKey = ({ x, y }: TilePoint): string => `${x},${y}`;

test("sequential formations start from the preceding formation's live positions", () => {
  const original = Array.from({ length: 24 }, (_, index) =>
    resident(`traveler-${String(47 - index).padStart(2, "0")}`, index % 6 - 3, Math.floor(index / 6) - 2));
  const paths = [
    [p(0, -30), p(28, 22), p(-28, 22)],
    rectangle(p(20, -12), 52, 34),
    star(p(-16, 14), 36, 15),
  ];

  let live = original;
  let precedingTargets: ReadonlyMap<string, TilePoint> | undefined;
  for (const [generation, points] of paths.entries()) {
    if (precedingTargets) {
      assert.deepEqual(
        positionMap(live),
        precedingTargets,
        "the next compilation must receive the last completed targets as its live state",
      );
    }
    const compiled = compileFormation({
      points,
      closed: true,
      residents: [...live].reverse(),
      generation: `sequential-${generation}`,
      maxRegions: 6,
    });
    assertSafeCompilation(compiled, live);
    const liveMetrics = measureFormation(compiled.path, live.map(({ position }) => position));
    assert.ok(Math.abs(compiled.metrics.meanCurveDistance - liveMetrics.meanCurveDistance) < 1e-12);
    assert.equal(compiled.metrics.maxCurveDistance, liveMetrics.maxCurveDistance);
    assert.equal(compiled.metrics.maxNormalizedArcGap, liveMetrics.maxNormalizedArcGap);
    assert.ok(measureFormation(compiled.path, compiled.targets.map(({ target }) => target)).maxCurveDistance < 0.75);

    precedingTargets = new Map(compiled.targets.map(({ residentId, target }) => [residentId, target]));
    live = compiled.targets.map(({ residentId, target }) => ({ id: residentId, position: target }));
  }

  assert.notDeepEqual(positionMap(live), positionMap(original));
});

test("six eight-resident square formations have centers arranged on a ring", () => {
  const ringCenter = p(120, 90);
  const squareCenters = polygon(ringCenter, 60, 6);
  const residents = squareCenters.flatMap((center, neighborhood) =>
    Array.from({ length: 8 }, (_, offset) => resident(
      `opaque-${String(((neighborhood * 8 + offset) * 29) % 48).padStart(2, "0")}`,
      center.x + offset % 4 - 2,
      center.y + Math.floor(offset / 4) - 1,
    )),
  );

  const compileSquares = (input: readonly FormationResident[]) => squareCenters.map((center, index) => {
    const local = input.filter(({ position }) => nearestIndex(position, squareCenters) === index);
    assert.equal(local.length, 8, `square ${index} has exactly eight location-derived residents`);
    return compileFormation({
      points: rectangle(center, 24, 24),
      closed: true,
      residents: local,
      generation: `square-${index}`,
      maxRegions: 1,
    });
  });

  const compiled = compileSquares(residents);
  const reversed = compileSquares([...residents].reverse());
  const allTargets = compiled.flatMap(({ targets }) => targets);
  assert.equal(new Set(allTargets.map(({ residentId }) => residentId)).size, 48);
  assert.equal(new Set(allTargets.map(({ target }) => pointKey(target))).size, 48);
  assert.deepEqual(targetMap(compiled), targetMap(reversed), "input permutation cannot change the placement");

  const observedCenters = compiled.map((formation, index) => {
    assertSafeCompilation(formation, residents.filter(({ position }) => nearestIndex(position, squareCenters) === index));
    assert.equal(formation.targets.length, 8);
    const observed = boundsCenter(formation.targets.map(({ target }) => target));
    assert.deepEqual(observed, squareCenters[index]);
    return observed;
  });
  const radii = observedCenters.map((center) => euclidean(center, ringCenter));
  assert.ok(Math.max(...radii) - Math.min(...radii) < 1, "square centers share one ring radius");
  assert.ok(radii.every((radius) => Math.abs(radius - 60) < 1));
});

test("left and right neighborhoods are derived from location rather than resident identity", () => {
  const residents = Array.from({ length: 28 }, (_, index) => {
    const side = index % 2 === 0 ? -1 : 1;
    return resident(
      `neighbor-${String((index * 11) % 28).padStart(2, "0")}`,
      side * (24 + index % 5),
      (index * 7) % 19 - 9,
    );
  });
  const neighborhoodPaths = [
    { side: -1, points: rectangle(p(-42, 0), 24, 36) },
    { side: 1, points: rectangle(p(42, 0), 24, 36) },
  ] as const;

  const run = (input: readonly FormationResident[]) => neighborhoodPaths.map(({ side, points }) => {
    const local = input.filter(({ position }) => Math.sign(position.x) === side);
    return compileFormation({ points, closed: true, residents: local, generation: `side-${side}`, maxRegions: 2 });
  });
  const result = run(residents);
  const permuted = run([...residents].reverse());

  assert.deepEqual(targetMap(result), targetMap(permuted));
  for (const [index, formation] of result.entries()) {
    const side = neighborhoodPaths[index].side;
    const expected = residents.filter(({ position }) => Math.sign(position.x) === side);
    assertSafeCompilation(formation, expected);
    assert.equal(formation.targets.length, 14);
    assert.ok(formation.targets.every(({ target }) => Math.sign(target.x) === side));
    assert.deepEqual(
      new Set(formation.targets.map(({ residentId }) => residentId)),
      new Set(expected.map(({ id }) => id)),
    );
  }
  assert.equal(new Set(result.flatMap(({ targets }) => targets.map(({ target }) => pointKey(target)))).size, 28);
});

test("later swarms can be positioned from the completed geometry of earlier swarms", () => {
  const residents = Array.from({ length: 30 }, (_, index) => {
    const group = Math.floor(index / 10);
    return resident(`swarm-${String((index * 17) % 31).padStart(2, "0")}`, group * 8 + index % 3, group * 5 + index % 4);
  });
  const groups = [residents.slice(0, 10), residents.slice(10, 20), residents.slice(20, 30)];

  const first = compileFormation({
    points: polygon(p(0, 0), 12, 16), closed: true, residents: groups[0], generation: "first", maxRegions: 1,
  });
  const firstBounds = bounds(first.targets.map(({ target }) => target));
  const secondCenter = p(firstBounds.maxX + 22, boundsCenter(first.targets.map(({ target }) => target)).y);
  const second = compileFormation({
    points: polygon(secondCenter, 10, 16), closed: true, residents: groups[1], generation: "second", maxRegions: 1,
  });
  const secondBounds = bounds(second.targets.map(({ target }) => target));
  const thirdCenter = p(boundsCenter(second.targets.map(({ target }) => target)).x, secondBounds.maxY + 20);
  const third = compileFormation({
    points: rectangle(thirdCenter, 18, 18), closed: true, residents: groups[2], generation: "third", maxRegions: 1,
  });

  assertSafeCompilation(first, groups[0]);
  assertSafeCompilation(second, groups[1]);
  assertSafeCompilation(third, groups[2]);
  assert.ok(bounds(first.targets.map(({ target }) => target)).maxX < bounds(second.targets.map(({ target }) => target)).minX);
  assert.ok(bounds(second.targets.map(({ target }) => target)).maxY < bounds(third.targets.map(({ target }) => target)).minY);
  assert.deepEqual(boundsCenter(second.targets.map(({ target }) => target)), secondCenter);
  assert.deepEqual(boundsCenter(third.targets.map(({ target }) => target)), thirdCenter);
  assert.equal(new Set([first, second, third].flatMap(({ targets }) => targets.map(({ target }) => pointKey(target)))).size, 30);
});

test("live residents progress through golden-ratio rectangles and then a golden spiral", () => {
  const phi = (1 + Math.sqrt(5)) / 2;
  const dimensions = [[21, 13], [34, 21], [55, 34]] as const;
  const aspectErrors = dimensions.map(([width, height]) => Math.abs(width / height - phi));
  assert.ok(aspectErrors[2] < aspectErrors[1] && aspectErrors[1] < aspectErrors[0]);

  let live = Array.from({ length: 48 }, (_, index) =>
    resident(`gold-${String((index * 29) % 53).padStart(2, "0")}`, index % 8 - 4, Math.floor(index / 8) - 3));
  for (const [generation, [width, height]] of dimensions.entries()) {
    const compiled = compileFormation({
      points: rectangle(p(0, 0), width, height),
      closed: true,
      residents: live,
      generation: `golden-rectangle-${generation}`,
      maxRegions: 1,
    });
    assertSafeCompilation(compiled, live);
    live = compiled.targets.map(({ residentId, target }) => ({ id: residentId, position: target }));
  }

  const fibonacciLengths = [13, 21, 34, 55, 89] as const;
  const spiral = orthogonalSpiral(p(-40, -20), fibonacciLengths);
  const compiledSpiral = compileFormation({
    points: spiral,
    closed: false,
    residents: live,
    generation: "golden-spiral",
    maxRegions: 1,
  });
  assertSafeCompilation(compiledSpiral, live);
  assert.deepEqual(compiledSpiral.path.segmentLengths, fibonacciLengths);
  for (let index = 2; index < fibonacciLengths.length; index += 1) {
    const currentError = Math.abs(fibonacciLengths[index] / fibonacciLengths[index - 1] - phi);
    const previousError = Math.abs(fibonacciLengths[index - 1] / fibonacciLengths[index - 2] - phi);
    assert.ok(currentError < previousError);
  }
  assert.ok(measureFormation(compiledSpiral.path, compiledSpiral.targets.map(({ target }) => target)).maxCurveDistance < 0.75);
  const targetArcs = compiledSpiral.targets.map(({ targetArc }) => targetArc).sort((left, right) => left - right);
  assert.ok(targetArcs.every((targetArc, index) => index === 0 || targetArc > targetArcs[index - 1]));
});

test("a completed circle is immutable pure-data history for a doubled transform", () => {
  const anchor = p(90, 70);
  const members = Array.from({ length: 24 }, (_, index) =>
    resident(`scale-${String((index * 19) % 29).padStart(2, "0")}`, anchor.x + index % 6, anchor.y + Math.floor(index / 6)));
  const circle = compileFormation({
    points: polygon(anchor, 18, 24), closed: true, residents: members, generation: "circle", maxRegions: 1,
  });
  assertSafeCompilation(circle, members);

  const completed = Object.freeze({
    anchor,
    closed: circle.path.closed,
    points: circle.path.points,
    residentIds: Object.freeze(circle.targets.map(({ residentId }) => residentId)),
  });
  const originalSnapshot = JSON.stringify(completed);
  const doubled = scaleCompletedChoreography(completed, 2);
  assert.equal(JSON.stringify(completed), originalSnapshot, "transforming history must not mutate the completed formation");
  assert.equal(doubled.closed, completed.closed);
  assert.deepEqual(new Set(doubled.residentIds), new Set(completed.residentIds));
  assert.equal(doubled.points.length, completed.points.length);
  doubled.points.forEach((point, index) => {
    assert.deepEqual(point, p(
      anchor.x + 2 * (completed.points[index].x - anchor.x),
      anchor.y + 2 * (completed.points[index].y - anchor.y),
    ));
  });

  const live = circle.targets.map(({ residentId, target }) => ({ id: residentId, position: target }));
  const transformed = compileFormation({
    points: doubled.points,
    closed: doubled.closed,
    residents: live,
    generation: "circle-doubled",
    maxRegions: 1,
  });
  assertSafeCompilation(transformed, live);
  assert.ok(Math.abs(transformed.path.length / circle.path.length - 2) < 1e-12);
  assert.ok(Math.abs(meanRadius(transformed.targets.map(({ target }) => target), anchor)
    / meanRadius(circle.targets.map(({ target }) => target), anchor) - 2) < 0.06);
});

function resident(id: string, x: number, y: number): FormationResident {
  return { id, position: p(x, y) };
}

function rectangle(center: TilePoint, width: number, height: number): TilePoint[] {
  const left = center.x - Math.floor(width / 2);
  const top = center.y - Math.floor(height / 2);
  return [p(left, top), p(left + width, top), p(left + width, top + height), p(left, top + height)];
}

function polygon(center: TilePoint, radius: number, count: number): TilePoint[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = 2 * Math.PI * index / count;
    return p(Math.round(center.x + radius * Math.cos(angle)), Math.round(center.y + radius * Math.sin(angle)));
  });
}

function star(center: TilePoint, outer: number, inner: number): TilePoint[] {
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + Math.PI * index / 5;
    const radius = index % 2 === 0 ? outer : inner;
    return p(Math.round(center.x + radius * Math.cos(angle)), Math.round(center.y + radius * Math.sin(angle)));
  });
}

function orthogonalSpiral(origin: TilePoint, lengths: readonly number[]): TilePoint[] {
  const directions = [p(1, 0), p(0, 1), p(-1, 0), p(0, -1)] as const;
  const points = [origin];
  lengths.forEach((length, index) => {
    const previous = points[points.length - 1];
    const direction = directions[index % directions.length];
    points.push(p(previous.x + direction.x * length, previous.y + direction.y * length));
  });
  return points;
}

function scaleCompletedChoreography<Id extends string>(
  completed: Readonly<{
    anchor: TilePoint;
    closed: boolean;
    points: readonly TilePoint[];
    residentIds: readonly Id[];
  }>,
  scale: number,
) {
  return Object.freeze({
    anchor: completed.anchor,
    closed: completed.closed,
    points: Object.freeze(completed.points.map((point) => p(
      completed.anchor.x + (point.x - completed.anchor.x) * scale,
      completed.anchor.y + (point.y - completed.anchor.y) * scale,
    ))),
    residentIds: completed.residentIds,
  });
}

function assertSafeCompilation<Id extends string, Generation>(
  compiled: FormationCompilation<Id, Generation>,
  residents: readonly FormationResident<Id>[],
): void {
  assert.equal(compiled.targets.length, residents.length);
  assert.deepEqual(
    new Set(compiled.targets.map(({ residentId }) => residentId)),
    new Set(residents.map(({ id }) => id)),
  );
  assert.equal(new Set(compiled.targets.map(({ target }) => pointKey(target))).size, residents.length);
  assert.ok(compiled.targets.every(({ target }) => Number.isInteger(target.x) && Number.isInteger(target.y)));
  assert.equal(compiled.allocations.length, residents.length);
  assert.equal(compiled.claims.size, residents.length);
}

function positionMap(residents: readonly FormationResident[]): ReadonlyMap<string, TilePoint> {
  return new Map([...residents].sort((left, right) => left.id.localeCompare(right.id)).map(({ id, position }) => [id, position]));
}

function targetMap(compilations: readonly FormationCompilation<string, unknown>[]): ReadonlyMap<string, TilePoint> {
  return new Map(compilations.flatMap(({ targets }) => targets)
    .sort((left, right) => left.residentId.localeCompare(right.residentId))
    .map(({ residentId, target }) => [residentId, target]));
}

function nearestIndex(point: TilePoint, centers: readonly TilePoint[]): number {
  let best = 0;
  for (let index = 1; index < centers.length; index += 1) {
    if (euclidean(point, centers[index]) < euclidean(point, centers[best])) best = index;
  }
  return best;
}

function euclidean(left: TilePoint, right: TilePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function bounds(points: readonly TilePoint[]) {
  return {
    minX: Math.min(...points.map(({ x }) => x)),
    maxX: Math.max(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxY: Math.max(...points.map(({ y }) => y)),
  };
}

function boundsCenter(points: readonly TilePoint[]): TilePoint {
  const box = bounds(points);
  return p((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
}

function meanRadius(points: readonly TilePoint[], center: TilePoint): number {
  return points.reduce((sum, point) => sum + euclidean(point, center), 0) / points.length;
}
