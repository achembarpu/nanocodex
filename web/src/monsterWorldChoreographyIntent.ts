const NUMBER_WORDS = Object.freeze(new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
]));

export function minimumChoreographyPhases(order: string): number {
  const normalized = order.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return 1;

  let explicit = 1;
  for (const match of normalized.matchAll(/\b(\d|one|two|three|four|five|six|seven|eight)\s+(?:\w+\s+){0,2}phases?\b/g)) {
    const count = Number(match[1]) || NUMBER_WORDS.get(match[1]) || 1;
    explicit = Math.max(explicit, count);
  }

  const transitions = [
    ...normalized.matchAll(/\b(?:then|afterwards|followed by|finally)\b/g),
    ...normalized.matchAll(/\bafter\b[^.!?;,]{0,48}\b(?:settles?|completes?|finishes?)\b/g),
    ...normalized.matchAll(/\b(?:transform|morph|re-?form|change)\s+(?:\w+\s+){0,3}(?:into|to)\b/g),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  let transitionCount = 0;
  let lastTransitionEnd = -1;
  for (const transition of transitions) {
    const start = transition.index ?? 0;
    if (start < lastTransitionEnd) continue;
    const prefix = normalized.slice(Math.max(0, start - 16), start);
    if (/\b(?:then|afterwards|finally)\b[^.!?;,]{0,24}$/.test(prefix)) continue;
    transitionCount += 1;
    lastTransitionEnd = start + transition[0].length;
  }

  return Math.min(8, Math.max(explicit, 1 + transitionCount));
}

export function retainedHistoryScale(order: string): number | undefined {
  const normalized = order.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(?:then )?(?:double it|make it twice as (?:large|big|wide))$/.test(normalized)) return 2;
  if (/^(?:then )?(?:halve it|make it half as (?:large|big|wide))$/.test(normalized)) return 0.5;
  return undefined;
}
