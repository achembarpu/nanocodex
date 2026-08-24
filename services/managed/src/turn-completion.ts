import type { Turn, TurnResult } from "nanocodex";

import type { ServerMessage, TurnCompleted } from "./protocol";

export type TurnTerminal = Extract<ServerMessage, {
  type: "turn_completed" | "turn_cancelled" | "turn_retryable" | "turn_blocked" | "turn_failed";
}>;

export type MaterializedTurnTerminal = Readonly<{
  terminal: TurnTerminal;
  reopenAgent: boolean;
}>;

export async function materializeTurnTerminal(
  id: string,
  turn: Turn,
): Promise<MaterializedTurnTerminal> {
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
      terminal: {
        type: "turn_completed",
        id,
        final_message: result.finalMessage,
        usage,
        ...(usageError === undefined ? {} : { usage_error: usageError }),
      },
      reopenAgent: false,
    };
  } catch (error) {
    return classifyTurnFailure(id, error);
  } finally {
    result?.dispose();
  }
}

export function classifyTurnFailure(id: string, error: unknown): MaterializedTurnTerminal {
  const failures = errorTree(error);
  const selected = selectFailure(failures);
  const code = selected.code;
  const message = selected.message;
  if (code === "cancelled") {
    return { terminal: { type: "turn_cancelled", id }, reopenAgent: false };
  }
  if (code === "blocked") {
    return {
      terminal: { type: "turn_blocked", id, error: message },
      reopenAgent: false,
    };
  }
  if (code === "reopen_required") {
    return {
      terminal: { type: "turn_retryable", id, error: message },
      reopenAgent: true,
    };
  }
  if (code === "retryable") {
    return {
      terminal: { type: "turn_retryable", id, error: message },
      reopenAgent: false,
    };
  }
  if (/\bagent (?:has been |was |is )?(?:already )?disposed\b/i.test(message)) {
    return {
      terminal: { type: "turn_retryable", id, error: message },
      reopenAgent: true,
    };
  }
  if (/\bturn was cancelled\b/i.test(message)) {
    return { terminal: { type: "turn_cancelled", id }, reopenAgent: false };
  }
  if (/ambiguous outcome/i.test(message)) {
    return {
      terminal: { type: "turn_blocked", id, error: message },
      reopenAgent: false,
    };
  }
  if (/blocked by unfinished operation|already active|agent stopped|turn completed|durability (?:store|driver)|transport|websocket|startup (?:validation )?timed out|connection rejected with HTTP 5\d\d/i.test(message)) {
    return {
      terminal: { type: "turn_retryable", id, error: message },
      reopenAgent: false,
    };
  }
  return {
    terminal: { type: "turn_failed", id, error: message },
    reopenAgent: false,
  };
}

type ClassifiedError = Readonly<{ code: string | undefined; message: string }>;

function errorTree(root: unknown): ClassifiedError[] {
  const failures: ClassifiedError[] = [];
  const pending = [root];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const error = pending.shift();
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
      if (seen.has(error)) continue;
      seen.add(error);
    }
    failures.push({ code: errorCode(error), message: errorMessage(error) });
    if (error instanceof AggregateError) pending.push(...error.errors);
    const cause = (error as { cause?: unknown } | null)?.cause;
    if (cause !== undefined) pending.push(cause);
  }
  return failures;
}

function selectFailure(failures: readonly ClassifiedError[]): ClassifiedError {
  const codePrecedence = ["reopen_required", "blocked", "cancelled", "retryable"];
  for (const code of codePrecedence) {
    const match = failures.find((failure) => failure.code === code);
    if (match) return match;
  }
  const reopen = failures.find((failure) =>
    /\bagent (?:has been |was |is )?(?:already )?disposed\b/i.test(failure.message)
  );
  if (reopen) return { code: "reopen_required", message: reopen.message };
  const blocked = failures.find((failure) => /ambiguous outcome/i.test(failure.message));
  if (blocked) return { code: "blocked", message: blocked.message };
  const cancelled = failures.find((failure) => /\bturn was cancelled\b/i.test(failure.message));
  if (cancelled) return { code: "cancelled", message: cancelled.message };
  const retryable = failures.find((failure) =>
    /blocked by unfinished operation|already active|agent stopped|turn completed|durability (?:store|driver)|transport|websocket|startup (?:validation )?timed out|connection rejected with HTTP 5\d\d/i.test(failure.message)
  );
  if (retryable) return { code: "retryable", message: retryable.message };
  const failed = failures.find((failure) => failure.code === "failed");
  if (failed) return failed;
  return failures[0] ?? { code: undefined, message: "unknown turn failure" };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
