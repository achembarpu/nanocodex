import { describe, expect, it, vi } from "vitest";

import type { Turn, TurnResult, TurnUsage } from "nanocodex";
import { classifyTurnFailure, materializeTurnResolution } from "../src/turn-completion";

const usage = {
  input_tokens: 10,
  cached_input_tokens: 2,
  cache_write_input_tokens: 0,
  output_tokens: 3,
  reasoning_output_tokens: 1,
  total_tokens: 13,
  estimated_cost: null,
  cost_status: "usage_not_reported",
} satisfies TurnUsage;

describe("materializeTurnResolution", () => {
  it("awaits usage, preserves the protocol shape, and releases the result", async () => {
    const dispose = vi.fn();
    const result = turnResult({ dispose, usage: vi.fn(async () => usage) });

    await expect(materializeTurnResolution("turn-1", turnWith(result))).resolves.toEqual({
      kind: "terminal",
      terminal: {
        type: "turn_completed",
        id: "turn-1",
        final_message: "done",
        usage,
        citations: [],
      },
      reopenAgent: false,
    });
    expect(result.usage).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps a completed result terminal when lazy usage materialization fails", async () => {
    const dispose = vi.fn();
    const result = turnResult({
      dispose,
      usage: vi.fn(async () => { throw new Error("usage payload is invalid"); }),
    });

    await expect(materializeTurnResolution("turn-2", turnWith(result))).resolves.toEqual({
      kind: "terminal",
      terminal: {
        type: "turn_completed",
        id: "turn-2",
        final_message: "done",
        usage: null,
        citations: [],
        usage_error: "usage payload is invalid",
      },
      reopenAgent: false,
    });
    expect(result.usage).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps a rejected preflight connection retryable", async () => {
    const turn = {
      result: async () => {
        throw new Error(
          "Agent connection rejected with HTTP 503: credential_broker_rejected",
        );
      },
    } as unknown as Turn;

    await expect(materializeTurnResolution("turn-3", turn)).resolves.toEqual({
      kind: "retry",
      error: "Agent connection rejected with HTTP 503: credential_broker_rejected",
      reopenAgent: false,
    });
  });

  it.each([
    ["retryable", "retry"],
    ["failed", "turn_failed"],
  ] as const)("preserves the WASM %s completion class", async (code, type) => {
    const error = Object.assign(new Error(`${code} turn`), { code });
    const turn = { result: async () => { throw error; } } as unknown as Turn;

    await expect(materializeTurnResolution("turn-4", turn)).resolves.toEqual(type === "retry" ? {
      kind: "retry",
      error: `${code} turn`,
      reopenAgent: false,
    } : {
      kind: "terminal",
      terminal: { type, id: "turn-4", error: `${code} turn` },
      reopenAgent: false,
    });
  });

  it("keeps reopen_required retryable while requiring a fresh Agent", () => {
    const error = Object.assign(new Error("durability owner was fenced"), {
      code: "reopen_required",
    });

    expect(classifyTurnFailure("turn-reopen", error)).toEqual({
      kind: "retry",
      error: "durability owner was fenced",
      reopenAgent: true,
    });
  });

  it("reduces nested rollback failures with reopen precedence", () => {
    const transient = Object.assign(new Error("broker preconnect returned 503"), {
      code: "retryable",
    });
    const reopen = Object.assign(new Error("durability owner must reopen"), {
      code: "reopen_required",
    });
    const aggregate = new AggregateError(
      [transient, new AggregateError([reopen], "shutdown rollback failed")],
      "creation and rollback both failed",
    );

    expect(classifyTurnFailure("turn-aggregate", aggregate)).toEqual({
      kind: "retry",
      error: "durability owner must reopen",
      reopenAgent: true,
    });
  });

  it("prefers a nested recoverable transport failure over a generic failed wrapper", () => {
    const recoverable = new Error("Agent connection rejected with HTTP 503: broker restarting");
    const failed = Object.assign(new Error("turn failed"), {
      cause: recoverable,
      code: "failed",
    });

    expect(classifyTurnFailure("turn-nested-retry", failed)).toEqual({
      kind: "retry",
      error: "Agent connection rejected with HTTP 503: broker restarting",
      reopenAgent: false,
    });
  });

  it.each([
    ["agent has been disposed", true],
    ["Cloudflare Agent EGRESS startup validation timed out", false],
    ["Agent connection rejected with HTTP 503: upstream unavailable", false],
  ] as const)("keeps transient pre-admission failure retryable: %s", (message, reopenAgent) => {
    expect(classifyTurnFailure("turn-pre-admission", new Error(message))).toEqual({
      kind: "retry",
      error: message,
      reopenAgent,
    });
  });
});

function turnResult(overrides: {
  dispose(): void;
  usage(): Promise<TurnUsage>;
}): TurnResult {
  return {
    finalMessage: "done",
    snapshot: async () => { throw new Error("snapshot should not be materialized"); },
    ...overrides,
  } as unknown as TurnResult;
}

function turnWith(result: TurnResult): Turn {
  return { result: async () => result } as unknown as Turn;
}
