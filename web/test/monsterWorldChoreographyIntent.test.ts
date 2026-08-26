import assert from "node:assert/strict";
import test from "node:test";

import {
  minimumChoreographyPhases,
  retainedHistoryScale,
} from "../src/monsterWorldChoreographyIntent.ts";

test("choreography intent preserves ordered transformations", () => {
  assert.equal(minimumChoreographyPhases("Everyone form one circle."), 1);
  assert.equal(minimumChoreographyPhases("Form a circle, then a square, then a star."), 3);
  assert.equal(minimumChoreographyPhases(
    "Form one circle, transform into six squares arranged on a ring, then merge into one star.",
  ), 3);
  assert.equal(minimumChoreographyPhases(
    "Split into a circle left and square right. After both settle, move the circle above the square.",
  ), 2);
  assert.equal(minimumChoreographyPhases("Grow through three distinct phases."), 3);
  assert.equal(minimumChoreographyPhases("Form a circle next to Scout."), 1);
  assert.equal(minimumChoreographyPhases("Form a circle after Scout arrives."), 1);
});

test("one transition is not counted twice when its verb follows a sequence marker", () => {
  assert.equal(minimumChoreographyPhases("Make a circle, then transform into a star."), 2);
  assert.equal(minimumChoreographyPhases("Make a circle, after settling change to a square."), 2);
});

test("history scaling accepts only an unambiguous whole-command follow-up", () => {
  assert.equal(retainedHistoryScale("Then double it."), 2);
  assert.equal(retainedHistoryScale("Make it half as wide"), 0.5);
  assert.equal(retainedHistoryScale("Form a circle, then double it."), undefined);
  assert.equal(retainedHistoryScale("Make twice as many squares."), undefined);
});
