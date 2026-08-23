import { describe, expect, it, vi } from "vitest";

import type { Turn, TurnResult, TurnUsage } from "nanocodex";
import { materializeTurnTerminal } from "../src/turn-completion";

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

describe("materializeTurnTerminal", () => {
  it("awaits usage, preserves the protocol shape, and releases the result", async () => {
    const dispose = vi.fn();
    const result = turnResult({ dispose, usage: vi.fn(async () => usage) });

    await expect(materializeTurnTerminal("turn-1", turnWith(result))).resolves.toEqual({
      type: "turn_completed",
      id: "turn-1",
      final_message: "done",
      usage,
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

    await expect(materializeTurnTerminal("turn-2", turnWith(result))).resolves.toEqual({
      type: "turn_completed",
      id: "turn-2",
      final_message: "done",
      usage: null,
      usage_error: "usage payload is invalid",
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

    await expect(materializeTurnTerminal("turn-3", turn)).resolves.toEqual({
      type: "turn_retryable",
      id: "turn-3",
      error: "Agent connection rejected with HTTP 503: credential_broker_rejected",
    });
  });

  it.each([
    ["retryable", "turn_retryable"],
    ["blocked", "turn_blocked"],
    ["failed", "turn_failed"],
  ] as const)("preserves the WASM %s completion class", async (code, type) => {
    const error = Object.assign(new Error(`${code} turn`), { code });
    const turn = { result: async () => { throw error; } } as unknown as Turn;

    await expect(materializeTurnTerminal("turn-4", turn)).resolves.toEqual({
      type,
      id: "turn-4",
      error: `${code} turn`,
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
