import type { Agent, AgentSessionContext, DefaultAgent, ForkOptions, Thinking } from "../types.mjs";

/** Appends adapter-owned developer context and returns the latest safe session context. */
export function appendDeveloperMessage(
  agent: Agent<object>,
  text: string,
): Promise<AgentSessionContext>;

/** Compacts retained history immediately without fabricating a user prompt. */
export function compact(agent: Agent<object>): Promise<void>;

/** Forks the latest checkpoint, or the exact completed result supplied in `options.at`. */
export function fork(agent: Agent<object>, options?: fork.Options): Promise<fork.ReturnType>;
export declare namespace fork {
  type Options = ForkOptions;
  type ReturnType = DefaultAgent;
}

/** Creates a clean sibling with the Agent's configuration and tools. */
export function spawn(agent: Agent<object>): Promise<spawn.ReturnType>;
export declare namespace spawn {
  type ReturnType = DefaultAgent;
}

/** Changes the reasoning effort for subsequently accepted turns. */
export function setThinking(agent: Agent<object>, thinking: Thinking): Promise<void>;

/** Enables or disables priority processing for subsequently accepted turns. */
export function setFastMode(agent: Agent<object>, enabled: boolean): Promise<void>;

/** Stops the driver and joins every resource owned by this Agent. */
export function shutdown(agent: Agent<object>): Promise<void>;
