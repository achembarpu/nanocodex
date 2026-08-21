import type { Turn, TurnResult } from "nanocodex";

import type { ServerMessage, TurnCompleted } from "./protocol";

type TurnFailed = Extract<ServerMessage, { type: "turn_failed" }>;

export async function materializeTurnTerminal(
  id: string,
  turn: Turn,
): Promise<TurnCompleted | TurnFailed> {
  let result: TurnResult | undefined;
  try {
    result = await turn.result();
    return {
      type: "turn_completed",
      id,
      final_message: result.finalMessage,
      usage: await result.usage(),
    };
  } catch (error) {
    return { type: "turn_failed", id, error: errorMessage(error) };
  } finally {
    result?.dispose();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
