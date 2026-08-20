import type { DefaultAgent, Turn, TurnResult } from "nanocodex";
import type { TerminalState } from "nanocodex-tui";

export type TerminalSize = Readonly<{ cols: number; rows: number }>;

export type TerminalHost = Readonly<{
  write(data: string | Uint8Array): void | Promise<void>;
  onData(listener: (data: string) => void): () => void;
  onResize(listener: (size: TerminalSize) => void): () => void;
  readonly cols: number;
  readonly rows: number;
}>;

export type AgentTerminalEvent = Readonly<{
  type: string;
  timestamp: number;
  [key: string]: unknown;
}>;

export type AgentTerminal = Readonly<{
  ready: Promise<void>;
  submit(input: string, options?: { intent?: "queue" | "steer" }): Promise<Turn | undefined>;
  cancel(): Promise<void>;
  render(): void;
  resize(): void;
  dispose(): void;
}>;

export function createAgentTerminal(options: {
  agent: DefaultAgent;
  terminal: TerminalHost;
  maxEntries?: number;
  onEvent?(event: AgentTerminalEvent & { result?: TurnResult }): void;
}): AgentTerminal;

export function renderTerminal(options: {
  state: TerminalState;
  input?: string;
  cursor?: number;
  cols?: number;
  rows?: number;
}): string;

export type XtermLike = {
  write(data: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: TerminalSize) => void): { dispose(): void };
  attachCustomKeyEventHandler?(listener: (event: KeyboardEvent) => boolean): void;
  readonly cols: number;
  readonly rows: number;
};

export type WtermLike = {
  write(data: string | Uint8Array): void | Promise<void>;
  onData: ((data: string) => void) | null;
  onResize: ((cols: number, rows: number) => void) | null;
  readonly cols: number;
  readonly rows: number;
};

export function encodeXtermKeyEvent(event: KeyboardEvent): string | null;
export function xtermAdapter(terminal: XtermLike): TerminalHost;
export function wtermAdapter(terminal: WtermLike): TerminalHost;
