import assert from "node:assert/strict";
import test from "node:test";

import {
  availableVisualHeight,
  GenerationRequestOwner,
  SerializedReplacementOwner,
  terminalRunningForStatus,
} from "../src/agentTerminalLifecycle.ts";
import {
  cssPixelValue,
  observeMediaQueryMatch,
  retainedSourceTreeState,
  scaledSourceTreeScrollTop,
  sourceTreeItemHeight,
  terminalComposerAction,
  terminalComposerMinimumHeight,
  visualViewportKeyboardInset,
} from "../src/mobileInteraction.ts";

test("auth refreshes deduplicate only within the current mutation generation", async () => {
  const owner = new GenerationRequestOwner<string>();
  const first = deferred<string>();
  const duringMutation = deferred<string>();
  const postMutation = deferred<string>();
  let firstStarts = 0;
  let duringMutationStarts = 0;
  let postMutationStarts = 0;

  const initial = owner.run(0, () => {
    firstStarts += 1;
    return first.promise;
  });
  assert.equal(owner.run(0, () => Promise.resolve("duplicate")), initial);

  const raced = owner.run(1, () => {
    duringMutationStarts += 1;
    return duringMutation.promise;
  });
  const current = owner.run(2, () => {
    postMutationStarts += 1;
    return postMutation.promise;
  });
  assert.notEqual(raced, initial);
  assert.notEqual(current, raced);
  first.resolve("stale");
  await initial;

  duringMutation.resolve("also stale");
  await raced;
  assert.equal(owner.run(2, () => Promise.resolve("duplicate")), current);
  assert.equal(firstStarts, 1);
  assert.equal(duringMutationStarts, 1);
  assert.equal(postMutationStarts, 1);
  postMutation.resolve("current");
  assert.equal(await current, "current");
});

test("agent replacements wait for graceful close and coalesce stale startup", async () => {
  const transitions: string[] = [];
  const closeFirst = deferred<void>();
  const owner = new SerializedReplacementOwner<{ name: string }>(async (value) => {
    transitions.push(`close:${value.name}:start`);
    if (value.name === "first") await closeFirst.promise;
    transitions.push(`close:${value.name}:done`);
  });

  assert.deepEqual(await owner.replace(async () => ({ name: "first" })), { name: "first" });
  const second = owner.replace(async () => {
    transitions.push("create:second");
    return { name: "second" };
  });
  const third = owner.replace(async () => {
    transitions.push("create:third");
    return { name: "third" };
  });

  await Promise.resolve();
  assert.deepEqual(transitions, ["close:first:start"]);
  closeFirst.resolve();
  assert.equal(await second, undefined);
  assert.deepEqual(await third, { name: "third" });
  assert.deepEqual(transitions, [
    "close:first:start",
    "close:first:done",
    "create:third",
  ]);
  await owner.clear();
  assert.deepEqual(transitions.slice(-2), ["close:third:start", "close:third:done"]);
});

test("a stale in-flight agent is closed before the current replacement starts", async () => {
  const creating = deferred<{ name: string }>();
  const creationStarted = deferred<void>();
  const transitions: string[] = [];
  const owner = new SerializedReplacementOwner<{ name: string }>(async (value) => {
    transitions.push(`close:${value.name}`);
  });

  const stale = owner.replace(() => {
    creationStarted.resolve();
    return creating.promise;
  });
  await creationStarted.promise;
  const current = owner.replace(async () => {
    transitions.push("create:current");
    return { name: "current" };
  });
  creating.resolve({ name: "stale" });

  assert.equal(await stale, undefined);
  assert.deepEqual(await current, { name: "current" });
  assert.deepEqual(transitions, ["close:stale", "create:current"]);
  await owner.clear();
});

test("a thousand replacement requests admit only the newest agent", async () => {
  const closeCurrent = deferred<void>();
  const created: number[] = [];
  const owner = new SerializedReplacementOwner<{ id: number }>(async (value) => {
    if (value.id === 0) await closeCurrent.promise;
  });
  await owner.replace(async () => ({ id: 0 }));

  const replacements = Array.from({ length: 1_000 }, (_, index) => owner.replace(async () => {
    const id = index + 1;
    created.push(id);
    return { id };
  }));
  closeCurrent.resolve();
  const results = await Promise.all(replacements);

  assert.deepEqual(created, [1_000]);
  assert.equal(results.filter((value) => value !== undefined).length, 1);
  assert.deepEqual(results.at(-1), { id: 1_000 });
  await owner.clear();
});

test("a receiver-close failure cannot poison later lifecycle commands", async () => {
  let failClose = true;
  const owner = new SerializedReplacementOwner<{ id: number }>(async () => {
    if (failClose) {
      failClose = false;
      throw new Error("receiver channel closed");
    }
  });
  await owner.replace(async () => ({ id: 1 }));

  await assert.rejects(owner.replace(async () => ({ id: 2 })), /receiver channel closed/);
  assert.deepEqual(await owner.replace(async () => ({ id: 3 })), { id: 3 });
  await owner.clear();
});

test("visual viewport height retains negative relative tops after keyboard panning", () => {
  assert.equal(availableVisualHeight({
    elementTop: 80,
    viewportHeight: 320,
    viewportOffsetTop: 140,
  }), 380);
  assert.equal(availableVisualHeight({
    elementTop: 180,
    viewportHeight: 320,
    viewportOffsetTop: 40,
  }), 180);
  assert.equal(availableVisualHeight({
    elementTop: 500,
    viewportHeight: 320,
    viewportOffsetTop: 40,
  }), 0);
  assert.equal(availableVisualHeight({
    elementTop: 500,
    minimum: 60,
    viewportHeight: 320,
    viewportOffsetTop: 40,
  }), 60);
});

test("visual viewport floors include the measured composer and bottom safe area", () => {
  const minimum = terminalComposerMinimumHeight({
    measuredComposerHeight: 86.2,
    safeAreaInsetBottom: cssPixelValue("34px"),
  });
  assert.equal(minimum, 96);
  assert.equal(availableVisualHeight({
    elementTop: 480,
    minimum,
    viewportHeight: 320,
    viewportOffsetTop: 40,
  }), 96);
  assert.equal(terminalComposerMinimumHeight({
    measuredComposerHeight: 112.1,
    safeAreaInsetBottom: 34,
  }), 113, "a taller measured composer remains authoritative");
});

test("keyboard occlusion continuously follows the visual viewport", () => {
  assert.equal(visualViewportKeyboardInset({
    baselineHeight: 852,
    viewportHeight: 852,
    viewportOffsetTop: 0,
  }), 0);
  assert.equal(visualViewportKeyboardInset({
    baselineHeight: 852,
    viewportHeight: 760,
    viewportOffsetTop: 8,
  }), 84);
  assert.equal(visualViewportKeyboardInset({
    baselineHeight: 852,
    viewportHeight: 700,
    viewportOffsetTop: 20,
  }), 132, "the composer follows the visible viewport bottom");
  assert.equal(visualViewportKeyboardInset({
    baselineHeight: 852,
    viewportHeight: 520,
    viewportOffsetTop: 44,
  }), 288);
  assert.equal(visualViewportKeyboardInset({
    baselineHeight: 852,
    viewportHeight: 852,
    viewportOffsetTop: 44,
  }), 0, "viewport panning alone does not move the composer");
});

test("a running touch agent keeps a visible send action for a follow-up", () => {
  assert.equal(terminalComposerAction(false, "hello"), "send");
  assert.equal(terminalComposerAction(true, "follow up"), "send");
  assert.equal(terminalComposerAction(true, "  "), "stop");
});

test("coarse Source rows resolve to a complete target without changing fine density", () => {
  assert.equal(sourceTreeItemHeight(false), 24);
  assert.equal(sourceTreeItemHeight(true), 44);
});

test("coarse target policy follows live pointer media changes and detaches cleanly", () => {
  let listener: (() => void) | undefined;
  const query = {
    matches: false,
    addEventListener(_type: string, next: () => void) {
      listener = next;
    },
    removeEventListener(_type: string, next: () => void) {
      if (listener === next) listener = undefined;
    },
  };
  const heights: number[] = [];
  const stop = observeMediaQueryMatch(
    query as unknown as MediaQueryList,
    (coarse) => heights.push(sourceTreeItemHeight(coarse)),
  );
  query.matches = true;
  listener?.();
  stop();
  query.matches = false;
  listener?.();

  assert.deepEqual(heights, [24, 44]);
  assert.equal(listener, undefined);
});

test("Source tree density swaps retain expansion, search, selection, and focus state", () => {
  const selectedPaths = ["src/main.rs"];
  const retained = retainedSourceTreeState({
    getFocusedPath: () => "src/lib.rs",
    getItem: (path) => ({
      isDirectory: () => true,
      isExpanded: () => path === "src",
    }),
    getSearchValue: () => "modal",
    getSelectedPaths: () => selectedPaths,
    isSearchOpen: () => true,
  }, ["src", "web"]);
  selectedPaths.push("web/src/main.tsx");

  assert.deepEqual(retained, {
    expandedPaths: ["src"],
    focusedPath: "src/lib.rs",
    searchQuery: "modal",
    selectedPaths: ["src/main.rs"],
  });
  assert.equal(scaledSourceTreeScrollTop({
    itemHeight: 24,
    nextItemHeight: 44,
    scrollTop: 120,
  }), 220, "the same logical row stays at the viewport boundary");
});

test("terminal activity is cleared whenever its Worker is not ready", () => {
  assert.equal(terminalRunningForStatus("ready", true), true);
  for (const status of ["idle", "starting", "stopped", "error"] as const) {
    assert.equal(terminalRunningForStatus(status, true), false, status);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}
