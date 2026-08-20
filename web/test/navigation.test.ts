import assert from "node:assert/strict";
import test from "node:test";
import { pathForSurface, surfaceFromUrl } from "../src/navigation.ts";

test("maps every Nanocodex surface to a stable application route", () => {
  assert.deepEqual(
    ["home", "docs", "code", "commits", "requests", "evals"].map((surface) => [
      surface,
      pathForSurface(surface as Parameters<typeof pathForSurface>[0]),
    ]),
    [
      ["home", "/"],
      ["docs", "/docs"],
      ["code", "/code"],
      ["commits", "/commits"],
      ["requests", "/requests"],
      ["evals", "/evals"],
    ],
  );
});

test("resolves direct routes and legacy view links", () => {
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/evals")), "evals");
  assert.equal(
    surfaceFromUrl(new URL("https://nanocodex.test/evals/worksets/terminal-bench/tasks/fix-git")),
    "evals",
  );
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/code/")), "code");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/docs/core/owned-agent")), "docs");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/?view=commits")), "commits");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/unknown")), "home");
});
