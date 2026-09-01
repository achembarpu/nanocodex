import type { Turn, TurnResult } from "nanocodex";

import type { ServerMessage, TurnCompleted } from "./protocol";

export type TurnTerminal = Extract<ServerMessage, {
  type: "turn_completed" | "turn_cancelled" | "turn_failed";
}>;

export type TurnResolution =
  | Readonly<{ kind: "terminal"; terminal: TurnTerminal; reopenAgent: false }>
  | Readonly<{ kind: "retry"; error: string; reopenAgent: boolean }>;

export async function materializeTurnResolution(
  id: string,
  turn: Turn,
): Promise<TurnResolution> {
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
      kind: "terminal",
      terminal: {
        type: "turn_completed",
        id,
        final_message: result.finalMessage,
        usage,
        citations: [],
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

export function classifyTurnFailure(id: string, error: unknown): TurnResolution {
  const selected = selectFailure(errorTree(error));
  if (selected.code === "cancelled" || /\bturn was cancelled\b/i.test(selected.message)) {
    return {
      kind: "terminal",
      terminal: { type: "turn_cancelled", id },
      reopenAgent: false,
    };
  }
  if (isRetryable(selected)) {
    return {
      kind: "retry",
      error: selected.message,
      reopenAgent: selected.code === "reopen_required"
        || /\bagent (?:has been |was |is )?(?:already )?disposed\b/i.test(selected.message),
    };
  }
  return {
    kind: "terminal",
    terminal: { type: "turn_failed", id, error: selected.message },
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
  for (const code of ["reopen_required", "cancelled", "retryable"]) {
    const match = failures.find((failure) => failure.code === code);
    if (match) return match;
  }
  return failures.find((failure) => isRetryable(failure))
    ?? failures.find((failure) => /\bturn was cancelled\b/i.test(failure.message))
    ?? failures.find((failure) => failure.code === "failed")
    ?? failures[0]
    ?? { code: undefined, message: "unknown turn failure" };
}

function isRetryable(failure: ClassifiedError): boolean {
  return failure.code === "reopen_required"
    || failure.code === "retryable"
    || /\bagent (?:has been |was |is )?(?:already )?disposed\b|already active|agent stopped|turn completed|durability (?:store|driver)|transport|websocket|startup (?:validation )?timed out|connection rejected with HTTP 5\d\d/i.test(failure.message);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { TurnCompleted };
