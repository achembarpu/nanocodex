/** Pure formation geometry and movement policy. Coordinates are world tiles. */
export type TilePoint = Readonly<{ x: number; y: number }>;

export type TilePolyline = Readonly<{
  points: readonly TilePoint[];
  closed: boolean;
  segmentLengths: readonly number[];
  cumulativeLengths: readonly number[];
  length: number;
}>;

export type ArcProjection = Readonly<{
  point: TilePoint;
  arc: number;
  normalizedArc: number;
  distance: number;
}>;

export type FormationRegion = Readonly<{
  index: number;
  startArc: number;
  endArc: number;
  capacity: number;
  center: TilePoint;
}>;

export type FormationResident<Id extends string = string> = Readonly<{
  id: Id;
  position: TilePoint;
}>;

export type RegionClaim<Generation = string | number> = Readonly<{
  generation: Generation;
  regionIndex: number;
}>;

export type RegionAllocation<Id extends string = string> = Readonly<{
  residentId: Id;
  regionIndex: number;
  travelCost: number;
  clearingPrice: number;
}>;

export type FormationTarget<Id extends string = string, Generation = string | number> = Readonly<{
  residentId: Id;
  regionIndex: number;
  target: TilePoint;
  targetArc: number;
  claim: RegionClaim<Generation>;
}>;

export type FormationMetrics = Readonly<{
  meanCurveDistance: number;
  maxCurveDistance: number;
  maxNormalizedArcGap: number;
}>;

export type FormationCompilation<Id extends string = string, Generation = string | number> = Readonly<{
  path: TilePolyline;
  regions: readonly FormationRegion[];
  allocations: readonly RegionAllocation<Id>[];
  targets: readonly FormationTarget<Id, Generation>[];
  claims: ReadonlyMap<Id, RegionClaim<Generation>>;
  metrics: FormationMetrics;
}>;

export type RegionMarketOptions<Id extends string, Generation> = Readonly<{
  generation: Generation;
  previousClaims?: ReadonlyMap<Id, RegionClaim<Generation>>;
  routeDistance?: (
    from: TilePoint,
    to: TilePoint,
    residentId: Id,
    region: FormationRegion,
  ) => number;
  travelWeight?: number;
  congestionWeight?: number;
  retentionBonus?: number;
}>;

export type CompileFormationOptions<Id extends string, Generation> = RegionMarketOptions<Id, Generation> & Readonly<{
  points: readonly TilePoint[];
  closed?: boolean;
  residents: readonly FormationResident<Id>[];
  maxRegions?: number;
}>;

export type GridPlannerResident<Id extends string = string> = FormationResident<Id> & Readonly<{
  target: TilePoint;
  waitAge?: number;
}>;

export type GridMove<Id extends string = string> = Readonly<{
  residentId: Id;
  from: TilePoint;
  to: TilePoint;
  moved: boolean;
}>;

export type GridTickPlan<Id extends string = string> = Readonly<{
  moves: readonly GridMove<Id>[];
  blocked: readonly Id[];
  nextWaitAges: ReadonlyMap<Id, number>;
}>;

export type GridPlannerOptions<Id extends string> = Readonly<{
  isBlocked: (point: TilePoint, residentId: Id) => boolean;
  routeDistance: (from: TilePoint, target: TilePoint, residentId: Id) => number;
}>;

const CARDINAL_STEPS = Object.freeze([
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
]);

export function createTilePolyline(
  input: readonly TilePoint[],
  closed = false,
): TilePolyline {
  if (input.length < 2) throw new Error("a formation path needs at least two points");
  const points: TilePoint[] = [];
  for (const point of input) {
    assertTilePoint(point);
    if (!points.length || pointKey(points[points.length - 1]) !== pointKey(point)) {
      points.push(Object.freeze({ x: point.x, y: point.y }));
    }
  }
  if (closed && points.length > 2 && pointKey(points[0]) === pointKey(points[points.length - 1])) {
    points.pop();
  }
  if (points.length < 2) throw new Error("a formation path needs two distinct points");
  const segmentCount = closed ? points.length : points.length - 1;
  const segmentLengths: number[] = [];
  const cumulativeLengths = [0];
  for (let index = 0; index < segmentCount; index += 1) {
    const length = euclidean(points[index], points[(index + 1) % points.length]);
    if (length === 0) continue;
    segmentLengths.push(length);
    cumulativeLengths.push(cumulativeLengths[cumulativeLengths.length - 1] + length);
  }
  const length = cumulativeLengths[cumulativeLengths.length - 1];
  if (length === 0) throw new Error("a formation path must have positive length");
  return Object.freeze({
    points: Object.freeze(points),
    closed,
    segmentLengths: Object.freeze(segmentLengths),
    cumulativeLengths: Object.freeze(cumulativeLengths),
    length,
  });
}

export function sampleTilePolyline(path: TilePolyline, arc: number): TilePoint {
  const resolvedArc = path.closed
    ? positiveModulo(arc, path.length)
    : clamp(arc, 0, path.length);
  const segment = segmentForArc(path, resolvedArc);
  const start = path.points[segment];
  const end = path.points[(segment + 1) % path.points.length];
  const segmentStart = path.cumulativeLengths[segment];
  const ratio = path.segmentLengths[segment] === 0
    ? 0
    : (resolvedArc - segmentStart) / path.segmentLengths[segment];
  return tilePoint(
    start.x + (end.x - start.x) * ratio,
    start.y + (end.y - start.y) * ratio,
  );
}

export function composeFormationPath(
  component: readonly TilePoint[],
  layout: Readonly<{
    points: readonly TilePoint[];
    closed: boolean;
    index: number;
    count: number;
  }>,
): readonly TilePoint[] {
  if (!Number.isSafeInteger(layout.count) || layout.count < 1) {
    throw new Error("layout count must be a positive integer");
  }
  if (!Number.isSafeInteger(layout.index) || layout.index < 0 || layout.index >= layout.count) {
    throw new Error("layout index must identify one component");
  }
  const path = createTilePolyline(layout.points, layout.closed);
  const center = sampleTilePolyline(path, path.length * layout.index / layout.count);
  return Object.freeze(component.map(({ x, y }) => tilePoint(x + center.x, y + center.y)));
}

export function projectOntoTilePolyline(path: TilePolyline, point: TilePoint): ArcProjection {
  assertTilePoint(point);
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestArc = 0;
  let bestX = path.points[0].x;
  let bestY = path.points[0].y;
  for (let index = 0; index < path.segmentLengths.length; index += 1) {
    const start = path.points[index];
    const end = path.points[(index + 1) % path.points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const denominator = dx * dx + dy * dy;
    const ratio = denominator === 0 ? 0 : clamp(
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator,
      0,
      1,
    );
    const x = start.x + dx * ratio;
    const y = start.y + dy * ratio;
    const distance = Math.hypot(point.x - x, point.y - y);
    const arc = path.cumulativeLengths[index] + path.segmentLengths[index] * ratio;
    if (distance < bestDistance || (distance === bestDistance && arc < bestArc)) {
      bestDistance = distance;
      bestArc = arc;
      bestX = x;
      bestY = y;
    }
  }
  const arc = path.closed && bestArc === path.length ? 0 : bestArc;
  return Object.freeze({
    point: tilePoint(bestX, bestY),
    arc,
    normalizedArc: arc / path.length,
    distance: bestDistance,
  });
}

export function partitionTilePolyline(
  path: TilePolyline,
  residentCount: number,
  maxRegions = 6,
): readonly FormationRegion[] {
  assertNonNegativeInteger(residentCount, "resident count");
  if (!Number.isInteger(maxRegions) || maxRegions < 1) {
    throw new Error("maxRegions must be a positive integer");
  }
  if (residentCount === 0) return Object.freeze([]);
  const count = Math.min(residentCount, maxRegions);
  const baseCapacity = Math.floor(residentCount / count);
  const largerRegions = residentCount % count;
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const startArc = path.length * index / count;
    const endArc = path.length * (index + 1) / count;
    return Object.freeze({
      index,
      startArc,
      endArc,
      capacity: baseCapacity + (index < largerRegions ? 1 : 0),
      center: sampleTilePolyline(path, (startArc + endArc) / 2),
    });
  }));
}

/**
 * Clears a unit-demand market with a deterministic primal/dual assignment.
 * Region capacities are expanded to congestion-priced seats; Hungarian duals
 * are the clearing prices. Canonically sorted ids make all ties input-order free.
 */
export function clearRegionMarket<Id extends string, Generation>(
  residentsInput: readonly FormationResident<Id>[],
  regions: readonly FormationRegion[],
  options: RegionMarketOptions<Id, Generation>,
): readonly RegionAllocation<Id>[] {
  const residents = canonicalResidents(residentsInput);
  const capacity = regions.reduce((sum, region) => sum + region.capacity, 0);
  if (capacity !== residents.length) {
    throw new Error("region capacity must equal resident count");
  }
  const travelWeight = finiteOption(options.travelWeight, 1, "travelWeight");
  const congestionWeight = finiteOption(options.congestionWeight, 1, "congestionWeight");
  const retentionBonus = finiteOption(options.retentionBonus, 2, "retentionBonus");
  const distance = options.routeDistance ?? ((from: TilePoint, to: TilePoint) => euclidean(from, to));
  const seats = regions.flatMap((region) => Array.from({ length: region.capacity }, (_, rank) => ({
    region,
    congestion: congestionWeight * (rank + 1) / region.capacity,
  })));
  if (!residents.length) return Object.freeze([]);
  const costs = residents.map((resident) => seats.map(({ region, congestion }) => {
    const travel = distance(resident.position, region.center, resident.id, region);
    if (!Number.isFinite(travel) || travel < 0) return Number.MAX_SAFE_INTEGER / 4;
    const previous = options.previousClaims?.get(resident.id);
    const retained = previous?.generation === options.generation
      && previous.regionIndex === region.index;
    return travel * travelWeight + congestion - (retained ? retentionBonus : 0);
  }));
  const solved = hungarian(costs);
  return Object.freeze(residents.map((resident, row) => {
    const seat = seats[solved.columnForRow[row]];
    return Object.freeze({
      residentId: resident.id,
      regionIndex: seat.region.index,
      travelCost: distance(resident.position, seat.region.center, resident.id, seat.region),
      clearingPrice: solved.columnPrices[solved.columnForRow[row]],
    });
  }));
}

export function deriveDensityTargets<Id extends string, Generation>(
  path: TilePolyline,
  residentsInput: readonly FormationResident<Id>[],
  regions: readonly FormationRegion[],
  allocations: readonly RegionAllocation<Id>[],
  generation: Generation,
): readonly FormationTarget<Id, Generation>[] {
  const residents = new Map(canonicalResidents(residentsInput).map((resident) => [resident.id, resident]));
  const byRegion = new Map<number, { resident: FormationResident<Id>; arc: number }[]>();
  for (const allocation of allocations) {
    const resident = residents.get(allocation.residentId);
    if (!resident) throw new Error(`allocation references unknown resident ${allocation.residentId}`);
    const group = byRegion.get(allocation.regionIndex) ?? [];
    group.push({ resident, arc: projectOntoTilePolyline(path, resident.position).arc });
    byRegion.set(allocation.regionIndex, group);
  }
  const targets: FormationTarget<Id, Generation>[] = [];
  for (const region of regions) {
    let group = byRegion.get(region.index) ?? [];
    group.sort((left, right) => left.arc - right.arc || compareIds(left.resident.id, right.resident.id));
    let seam = region.startArc;
    if (path.closed && regions.length === 1 && group.length > 1) {
      let largestGap = -1;
      let afterGap = 0;
      for (let index = 0; index < group.length; index += 1) {
        const next = (index + 1) % group.length;
        const gap = next === 0
          ? group[0].arc + path.length - group[index].arc
          : group[next].arc - group[index].arc;
        if (gap > largestGap) {
          largestGap = gap;
          afterGap = next;
        }
      }
      group = [...group.slice(afterGap), ...group.slice(0, afterGap)];
      seam = group[0].arc - path.length / (2 * group.length);
    }
    for (let rank = 0; rank < group.length; rank += 1) {
      const width = region.endArc - region.startArc;
      const targetArc = path.closed && regions.length === 1
        ? positiveModulo(seam + width * (rank + 0.5) / group.length, path.length)
        : region.startArc + width * (rank + 0.5) / group.length;
      targets.push(Object.freeze({
        residentId: group[rank].resident.id,
        regionIndex: region.index,
        target: sampleTilePolyline(path, targetArc),
        targetArc,
        claim: Object.freeze({ generation, regionIndex: region.index }),
      }));
    }
  }
  targets.sort((left, right) => compareIds(left.residentId, right.residentId));
  return Object.freeze(targets);
}

export function measureFormation(
  path: TilePolyline,
  positions: readonly TilePoint[],
): FormationMetrics {
  if (positions.length === 0) {
    return Object.freeze({ meanCurveDistance: 0, maxCurveDistance: 0, maxNormalizedArcGap: 1 });
  }
  const projections = positions.map((point) => projectOntoTilePolyline(path, point));
  const arcs = projections.map(({ normalizedArc }) => normalizedArc).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < arcs.length; index += 1) gaps.push(arcs[index] - arcs[index - 1]);
  if (path.closed) gaps.push(1 - arcs[arcs.length - 1] + arcs[0]);
  else gaps.push(arcs[0], 1 - arcs[arcs.length - 1]);
  const distances = projections.map(({ distance }) => distance);
  return Object.freeze({
    meanCurveDistance: distances.reduce((sum, value) => sum + value, 0) / distances.length,
    maxCurveDistance: Math.max(...distances),
    maxNormalizedArcGap: Math.max(0, ...gaps),
  });
}

export function compileFormation<Id extends string, Generation>(
  options: CompileFormationOptions<Id, Generation>,
): FormationCompilation<Id, Generation> {
  const path = createTilePolyline(options.points, options.closed);
  const residents = canonicalResidents(options.residents);
  const regions = partitionTilePolyline(path, residents.length, options.maxRegions);
  const allocations = clearRegionMarket(residents, regions, options);
  const targets = deriveDensityTargets(path, residents, regions, allocations, options.generation);
  return Object.freeze({
    path,
    regions,
    allocations,
    targets,
    claims: new Map(targets.map(({ residentId, claim }) => [residentId, claim])),
    metrics: measureFormation(path, residents.map(({ position }) => position)),
  });
}

/** Plans one simultaneous step. A recursively displaced occupant inherits the
 * mover's priority. Backtracking rejects collisions and 2-cycles, while cycles
 * of three or more commit atomically. */
export function planJointGridTick<Id extends string>(
  input: readonly GridPlannerResident<Id>[],
  options: GridPlannerOptions<Id>,
): GridTickPlan<Id> {
  const residents = [...input].sort((left, right) =>
    (right.waitAge ?? 0) - (left.waitAge ?? 0) || compareIds(left.id, right.id));
  const byId = new Map<Id, GridPlannerResident<Id>>();
  const occupantAt = new Map<string, Id>();
  for (const resident of residents) {
    assertTilePoint(resident.position);
    assertTilePoint(resident.target);
    if (byId.has(resident.id)) throw new Error(`duplicate resident id ${resident.id}`);
    if (occupantAt.has(pointKey(resident.position))) throw new Error("residents must start on distinct tiles");
    byId.set(resident.id, resident);
    occupantAt.set(pointKey(resident.position), resident.id);
  }
  let selected = new Map<Id, TilePoint>();
  let destinationOwner = new Map<string, Id>();
  const resolving: Id[] = [];

  const candidatesFor = (resident: GridPlannerResident<Id>): TilePoint[] => {
    const candidates = [
      ...CARDINAL_STEPS.map((step) => tilePoint(resident.position.x + step.x, resident.position.y + step.y)),
      resident.position,
    ].filter((point) => !options.isBlocked(point, resident.id));
    candidates.sort((left, right) => {
      const leftStay = samePoint(left, resident.position);
      const rightStay = samePoint(right, resident.position);
      const leftDistance = options.routeDistance(left, resident.target, resident.id);
      const rightDistance = options.routeDistance(right, resident.target, resident.id);
      const leftScore = (Number.isFinite(leftDistance) ? leftDistance : Number.MAX_SAFE_INTEGER)
        + (leftStay && !samePoint(resident.position, resident.target) ? 1 : 0);
      const rightScore = (Number.isFinite(rightDistance) ? rightDistance : Number.MAX_SAFE_INTEGER)
        + (rightStay && !samePoint(resident.position, resident.target) ? 1 : 0);
      return leftScore - rightScore
        || Number(leftStay) - Number(rightStay)
        || left.y - right.y
        || left.x - right.x;
    });
    return candidates;
  };

  const assign = (id: Id): boolean => {
    if (selected.has(id)) return true;
    const resident = byId.get(id);
    if (!resident) return false;
    resolving.push(id);
    for (const candidate of candidatesFor(resident)) {
      const key = pointKey(candidate);
      if (destinationOwner.has(key)) continue;
      const selectedBefore = new Map(selected);
      const ownersBefore = new Map(destinationOwner);
      selected.set(id, candidate);
      destinationOwner.set(key, id);
      const occupant = occupantAt.get(key);
      let accepted = true;
      if (occupant !== undefined && occupant !== id) {
        const cycleStart = resolving.indexOf(occupant);
        if (cycleStart >= 0) {
          accepted = resolving.length - cycleStart >= 3;
        } else if (!selected.has(occupant)) {
          accepted = assign(occupant);
        } else {
          accepted = !samePoint(selected.get(occupant)!, byId.get(occupant)!.position);
        }
      }
      if (accepted) {
        resolving.pop();
        return true;
      }
      selected = selectedBefore;
      destinationOwner = ownersBefore;
    }
    resolving.pop();
    return false;
  };

  for (const resident of residents) {
    if (!assign(resident.id)) {
      const key = pointKey(resident.position);
      if (!destinationOwner.has(key)) {
        selected.set(resident.id, resident.position);
        destinationOwner.set(key, resident.id);
      }
    }
  }
  // A failed upstream choice can leave an unassigned resident whose start was
  // reserved. Re-plan the whole set with all stays as a guaranteed safe floor.
  if (selected.size !== residents.length) {
    selected = new Map(residents.map((resident) => [resident.id, resident.position]));
  }
  const canonical = [...residents].sort((left, right) => compareIds(left.id, right.id));
  const moves = canonical.map((resident) => {
    const to = selected.get(resident.id) ?? resident.position;
    return Object.freeze({ residentId: resident.id, from: resident.position, to, moved: !samePoint(to, resident.position) });
  });
  const blocked = canonical
    .filter((resident) => samePoint(selected.get(resident.id) ?? resident.position, resident.position)
      && !samePoint(resident.position, resident.target))
    .map(({ id }) => id);
  return Object.freeze({
    moves: Object.freeze(moves),
    blocked: Object.freeze(blocked),
    nextWaitAges: new Map(canonical.map((resident) => {
      const destination = selected.get(resident.id) ?? resident.position;
      const moved = !samePoint(destination, resident.position);
      const waiting = !samePoint(resident.position, resident.target);
      if (!waiting) return [resident.id, 0];
      if (!moved) return [resident.id, (resident.waitAge ?? 0) + 1];
      const before = options.routeDistance(resident.position, resident.target, resident.id);
      const after = options.routeDistance(destination, resident.target, resident.id);
      return [resident.id, after < before ? 0 : (resident.waitAge ?? 0) + 1];
    })),
  });
}

function canonicalResidents<Id extends string>(
  input: readonly FormationResident<Id>[],
): FormationResident<Id>[] {
  const residents = [...input].sort((left, right) => compareIds(left.id, right.id));
  for (let index = 0; index < residents.length; index += 1) {
    assertTilePoint(residents[index].position);
    if (index > 0 && residents[index - 1].id === residents[index].id) {
      throw new Error(`duplicate resident id ${residents[index].id}`);
    }
  }
  return residents;
}

function hungarian(costs: readonly (readonly number[])[]): Readonly<{
  columnForRow: readonly number[];
  columnPrices: readonly number[];
}> {
  const size = costs.length;
  const rowPotential = Array<number>(size + 1).fill(0);
  const columnPotential = Array<number>(size + 1).fill(0);
  const rowForColumn = Array<number>(size + 1).fill(0);
  const previousColumn = Array<number>(size + 1).fill(0);
  for (let row = 1; row <= size; row += 1) {
    rowForColumn[0] = row;
    const minimum = Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array<boolean>(size + 1).fill(false);
    let column = 0;
    do {
      used[column] = true;
      const activeRow = rowForColumn[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (used[candidate]) continue;
        const reduced = costs[activeRow - 1][candidate - 1]
          - rowPotential[activeRow] - columnPotential[candidate];
        if (reduced < minimum[candidate]) {
          minimum[candidate] = reduced;
          previousColumn[candidate] = column;
        }
        if (minimum[candidate] < delta || (minimum[candidate] === delta && candidate < nextColumn)) {
          delta = minimum[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (used[candidate]) {
          rowPotential[rowForColumn[candidate]] += delta;
          columnPotential[candidate] -= delta;
        } else minimum[candidate] -= delta;
      }
      column = nextColumn;
    } while (rowForColumn[column] !== 0);
    do {
      const previous = previousColumn[column];
      rowForColumn[column] = rowForColumn[previous];
      column = previous;
    } while (column !== 0);
  }
  const columnForRow = Array<number>(size).fill(-1);
  for (let column = 1; column <= size; column += 1) {
    columnForRow[rowForColumn[column] - 1] = column - 1;
  }
  return Object.freeze({
    columnForRow: Object.freeze(columnForRow),
    columnPrices: Object.freeze(columnPotential.slice(1).map((value) => -value)),
  });
}

function segmentForArc(path: TilePolyline, arc: number): number {
  if (!path.closed && arc >= path.length) return path.segmentLengths.length - 1;
  let low = 0;
  let high = path.segmentLengths.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (path.cumulativeLengths[middle + 1] <= arc) low = middle + 1;
    else high = middle;
  }
  return low;
}

function tilePoint(x: number, y: number): TilePoint {
  return Object.freeze({ x: Math.round(x), y: Math.round(y) });
}

function pointKey(point: TilePoint): string {
  return `${point.x},${point.y}`;
}

function samePoint(left: TilePoint, right: TilePoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function euclidean(left: TilePoint, right: TilePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function assertTilePoint(point: TilePoint): void {
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) {
    throw new Error("formation coordinates must be integer world tiles");
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

function finiteOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${name} must be finite and non-negative`);
  return resolved;
}
