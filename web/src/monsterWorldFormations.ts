export const WORLD_FORMATION_KINDS = [
  "triangle",
  "square",
  "circle",
  "star",
  "double_ring",
] as const;

export type WorldFormationKind = (typeof WORLD_FORMATION_KINDS)[number];

export type WorldFormationOffset = Readonly<{
  dxPixels: number;
  dyPixels: number;
}>;

export type WorldFormationPreset = Readonly<{
  kind: WorldFormationKind;
  label: string;
  prompt: string;
}>;

export const WORLD_FORMATION_LADDER: readonly WorldFormationPreset[] = Object.freeze([
  formationPreset(
    "triangle",
    "Triangle",
    "Form a triangle around Scout using the triangle slot. Space every edge evenly with no gaps or overlaps. Correct blocked movement, then hold.",
  ),
  formationPreset(
    "square",
    "Square",
    "Form a square around Scout using your square slot. Space every edge evenly with no gaps or overlaps. Correct blocked movement, then hold.",
  ),
  formationPreset(
    "circle",
    "Circle",
    "Form a circle around Scout using the circle slot. Spread evenly on the ring with no gaps or overlaps. Correct blocked movement, then hold.",
  ),
  formationPreset(
    "star",
    "Star",
    "Form a five-point star around Scout using the star slot. Space edges evenly with no gaps or overlaps. Correct blocked movement, then hold.",
  ),
  formationPreset(
    "double_ring",
    "Double ring",
    "Form two rings around Scout. Use your double-ring slot; spread evenly with no gaps or overlaps. Correct blocked movement, then hold.",
  ),
]);

export function formationKindForPrompt(input: string): WorldFormationKind | undefined {
  const normalized = input.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
  if (/\b(?:two|double|concentric) rings?\b/.test(normalized)) return "double_ring";
  if (/\bfive point star\b|\bstar\b/.test(normalized)) return "star";
  if (/\bcircle\b|\bclosed ring\b/.test(normalized)) return "circle";
  if (/\bsquare\b/.test(normalized)) return "square";
  if (/\btriangle\b/.test(normalized)) return "triangle";
  return undefined;
}

export function formationOffset(
  kind: WorldFormationKind,
  index: number,
  count: number,
): WorldFormationOffset {
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count || count < 1) {
    return Object.freeze({ dxPixels: 0, dyPixels: 0 });
  }
  if (kind === "circle") {
    const angle = -Math.PI / 2 + Math.PI * 2 * index / count;
    return roundedOffset(80 * Math.cos(angle), 80 * Math.sin(angle));
  }
  if (kind === "triangle") {
    return closedPolylineOffset([
      point(0, -80),
      point(72, 48),
      point(-72, 48),
    ], index, count);
  }
  if (kind === "square") {
    return closedPolylineOffset([
      point(0, -72),
      point(72, 0),
      point(0, 72),
      point(-72, 0),
    ], index, count);
  }
  if (kind === "star") {
    return closedPolylineOffset(
      Array.from({ length: 10 }, (_, vertex) => {
        const angle = -Math.PI / 2 + vertex * Math.PI / 5;
        const radius = vertex % 2 === 0 ? 80 : 32;
        return point(radius * Math.cos(angle), radius * Math.sin(angle));
      }),
      index,
      count,
    );
  }
  const innerCount = doubleRingInnerCount(count);
  const inner = index < innerCount;
  const ringIndex = inner ? index : index - innerCount;
  const ringCount = inner ? innerCount : count - innerCount;
  const angle = -Math.PI / 2 + Math.PI * 2 * (ringIndex + 0.5) / Math.max(ringCount, 1);
  const radius = inner ? 40 : 80;
  return roundedOffset(radius * Math.cos(angle), radius * Math.sin(angle));
}

export function formationPathGroups(
  kind: WorldFormationKind,
  count: number,
): readonly Readonly<{ indexes: readonly number[]; closed: boolean }>[] {
  const indexes = Array.from({ length: Math.max(count, 0) }, (_, index) => index);
  if (kind !== "double_ring") return Object.freeze([Object.freeze({ indexes: Object.freeze(indexes), closed: true })]);
  const innerCount = doubleRingInnerCount(count);
  return Object.freeze([
    Object.freeze({ indexes: Object.freeze(indexes.slice(0, innerCount)), closed: true }),
    Object.freeze({ indexes: Object.freeze(indexes.slice(innerCount)), closed: true }),
  ]);
}

function formationPreset(
  kind: WorldFormationKind,
  label: string,
  prompt: string,
): WorldFormationPreset {
  return Object.freeze({ kind, label, prompt });
}

function doubleRingInnerCount(count: number): number {
  if (count <= 1) return count;
  return Math.max(1, Math.min(count - 1, Math.round(count / 3)));
}

function closedPolylineOffset(
  vertices: readonly WorldFormationOffset[],
  index: number,
  count: number,
): WorldFormationOffset {
  const lengths = vertices.map((start, vertex) => distance(start, vertices[(vertex + 1) % vertices.length]!));
  const perimeter = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = perimeter * index / count;
  for (let segment = 0; segment < vertices.length; segment += 1) {
    const length = lengths[segment]!;
    if (remaining <= length || segment === vertices.length - 1) {
      const start = vertices[segment]!;
      const end = vertices[(segment + 1) % vertices.length]!;
      const progress = length === 0 ? 0 : Math.min(1, remaining / length);
      return roundedOffset(
        start.dxPixels + (end.dxPixels - start.dxPixels) * progress,
        start.dyPixels + (end.dyPixels - start.dyPixels) * progress,
      );
    }
    remaining -= length;
  }
  return roundedOffset(0, 0);
}

function point(dxPixels: number, dyPixels: number): WorldFormationOffset {
  return Object.freeze({ dxPixels, dyPixels });
}

function roundedOffset(dxPixels: number, dyPixels: number): WorldFormationOffset {
  const roundedX = Math.round(dxPixels / 8) * 8;
  const roundedY = Math.round(dyPixels / 8) * 8;
  return Object.freeze({
    dxPixels: Object.is(roundedX, -0) ? 0 : roundedX,
    dyPixels: Object.is(roundedY, -0) ? 0 : roundedY,
  });
}

function distance(left: WorldFormationOffset, right: WorldFormationOffset): number {
  return Math.hypot(right.dxPixels - left.dxPixels, right.dyPixels - left.dyPixels);
}
