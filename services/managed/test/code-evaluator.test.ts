import { describe, expect, it } from "vitest";

import { managedCodeEvaluator } from "../src/code-evaluator";

describe("managedCodeEvaluator", () => {
  it("creates an independently queued evaluator for each managed session", async () => {
    const [first, second] = await Promise.all([
      managedCodeEvaluator(),
      managedCodeEvaluator(),
    ]);

    expect(first).not.toBe(second);
  });
});

