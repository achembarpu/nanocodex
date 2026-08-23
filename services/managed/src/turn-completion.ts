import type { Turn, TurnResult } from "nanocodex";

import type { ServerMessage, TurnCompleted } from "./protocol";

export type TurnTerminal = Extract<ServerMessage, {
  type: "turn_completed" | "turn_cancelled" | "turn_retryable" | "turn_blocked" | "turn_failed";
}>;

export async function materializeTurnTerminal(
  id: string,
  turn: Turn,
): Promise<TurnTerminal> {
  let result: TurnResult | undefined;
  try {
    result = await turn.result();
    let usage: Awaited<ReturnType<TurnResult["usage"]>> | null = null;
    let usageError: string | undefined;
    try {
      usage = await result.usage();
    } catch (error) {
      usageError = errorMessage(error);
    }
    return {
      type: "turn_completed",
      id,
      final_message: result.finalMessage,
      usage,
      ...(usageError === undefined ? {} : { usage_error: usageError }),
    };
  } catch (error) {
    const code = errorCode(error);
    const message = errorMessage(error);
    if (code === "cancelled" || /\bturn was cancelled\b/i.test(message)) {
      return { type: "turn_cancelled", id };
    }
    if (code === "blocked" || /ambiguous outcome/i.test(message)) {
      return { type: "turn_blocked", id, error: message };
    }
    if (code === "retryable"
      || /agent stopped|turn completed|durability (?:store|driver)|transport|websocket/i.test(message)) {
      return { type: "turn_retryable", id, error: message };
    }
    return { type: "turn_failed", id, error: message };
  } finally {
    result?.dispose();
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
