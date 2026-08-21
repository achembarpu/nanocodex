import type { DefaultAgent } from "../types.mjs";
import type { create as createBrowserAgent } from "./Agent.mjs";

export type WorkerLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: unknown): void;
  terminate?(): void;
};

export type WorkerAgentOptions = Readonly<{
  worker?: WorkerLike | (() => WorkerLike) | undefined;
  workerFactory?: (() => WorkerLike) | undefined;
  maxPendingRpcs?: number | undefined;
  /** Cancels private Worker preparation or boot; it does not govern a ready Agent. */
  signal?: AbortSignal | undefined;
}>;

/** Internal package seam used by browser/Agent.mjs to preserve Agent.create. */
export function createWorkerAgent(
  options?: createBrowserAgent.Options,
  workerOptions?: WorkerAgentOptions,
): Promise<DefaultAgent>;

/** Internal package preparation used by browser config. */
export function prepareWorkerAgent(options?: Readonly<{
  harness?: false | undefined;
  threadId?: string | undefined;
  origin?: string | undefined;
}>, workerOptions?: WorkerAgentOptions): Promise<void>;

export type WorkerAgentRuntime = Readonly<{ dispose(): void }>;
export type WorkerAgentScope = WorkerLike;
export type WorkerAgentRuntimeOptions = Readonly<{
  createAgent?: (options: import("../host/Agent.mjs").create.Options) => Promise<DefaultAgent> | DefaultAgent;
  prewarmLocal?: (options: { threadId: string; origin?: string | undefined }) => Promise<void> | void;
}>;

/** Installs the package-owned RPC runtime in a module Worker global scope. */
export function installWorkerAgentRuntime(
  scope?: WorkerAgentScope,
  options?: WorkerAgentRuntimeOptions,
): WorkerAgentRuntime;
