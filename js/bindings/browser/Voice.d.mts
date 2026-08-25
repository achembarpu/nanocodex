import type { DefaultAgent } from "../types.mjs";
import type { Agent as ManagedAgent } from "../managed/Agent.mjs";
import type { ConnectAgent } from "../cloud/types.mjs";

export const voices: readonly ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"];
export const defaultVoice: "cove";
export type VoiceName = (typeof voices)[number];
export type Transcript = Readonly<{ speaker: "user" | "assistant"; text: string }>;
export type Snapshot = Readonly<{
  error: Error | undefined;
  status: "idle" | "connecting" | "active" | "error";
  statusText: string | undefined;
  transcripts: readonly Transcript[];
  voice: VoiceName | undefined;
}>;
export type Event =
  | Readonly<{ type: "connecting"; voice: VoiceName }>
  | Readonly<{ type: "started"; voice: VoiceName }>
  | Readonly<{ type: "transcript"; speaker: "user" | "assistant"; text: string }>
  | Readonly<{ type: "error"; error: Error }>
  | Readonly<{ type: "stopped" }>;
export type Options = Readonly<{
  voice?: VoiceName | undefined;
  callUrl?: string | URL | undefined;
  sidebandUrl?(callId: string, sessionId: string): string | URL | Promise<string | URL>;
  captureMicrophone?(): Promise<MediaStream>;
  beforeAgentTurn?(): Promise<void>;
}>;
export type Voice = Readonly<{
  cancel(): Promise<boolean>;
  destroy(): Promise<void>;
  getSnapshot(): Snapshot;
  onEvent(listener: (event: Event) => void): () => void;
  start(options?: { voice?: VoiceName | undefined }): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: () => void): () => void;
  toggle(options?: { voice?: VoiceName | undefined }): Promise<void>;
}>;
export function create(agent: DefaultAgent | ManagedAgent | ConnectAgent, options?: Options): Voice;
