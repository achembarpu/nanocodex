import type {
  Agent,
  PromptInput,
  SessionSnapshot,
  Turn,
  TurnResult,
  TurnUsage,
} from "../types.mjs";

/** Accepts a prompt on an owned Agent and returns its independently awaitable Turn. */
export function prompt<const agent extends Agent<object>>(
  agent: agent,
  options: prompt.Options,
): prompt.ReturnType<agent>;
export declare namespace prompt {
  type Options = { input: PromptInput; id?: string | undefined };
  type ReturnType<agent extends Agent<object> = Agent<object>> = Turn<agent>;
}

/** Waits for a Turn's typed completed result. */
export function getResult(turn: Turn): Promise<getResult.ReturnType>;
export declare namespace getResult {
  type ReturnType = TurnResult;
}

/** Returns a completed result's serializable session snapshot. */
export function getSnapshot(result: TurnResult): getSnapshot.ReturnType;
export declare namespace getSnapshot {
  type ReturnType = SessionSnapshot;
}

/** Returns exact aggregate token usage from a completed result. */
export function getUsage(result: TurnResult): getUsage.ReturnType;
export declare namespace getUsage {
  type ReturnType = TurnUsage;
}

/** Adds input to an active Turn. */
export function steer(turn: Turn, options: steer.Options): Promise<void>;
export declare namespace steer {
  type Options = { input: PromptInput };
  type ReturnType = void;
}

/** Cancels an active or queued Turn. */
export function cancel(turn: Turn): Promise<void>;
export declare namespace cancel {
  type ReturnType = void;
}
