declare const subagentToolBrand: unique symbol;

/** Opaque selector for the Rust-owned subagent tool set. */
export type Tool = Readonly<{
  [subagentToolBrand]: true;
}>;

export type Subagents = readonly [Tool];

export interface Options {
  /** Maximum number of concurrently active subagent turns. Defaults to 32. */
  maxConcurrency?: number | undefined;
}

/** Returns a spreadable Rust-backed tool extension for an Agent's tools array. */
export function create(options?: Options): Subagents;
