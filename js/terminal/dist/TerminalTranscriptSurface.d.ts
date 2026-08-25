import { type ReactNode } from "react";
import type { AgentEntry } from "nanocodex-react/agent";
import type { AgentStatus, AgentTerminalMode } from "./types.js";
export type VoiceTerminalEntry = Readonly<{
    afterEntryId?: string;
    id: string;
    kind: "user" | "assistant";
    source: "voice";
    streaming: false;
    text: string;
}>;
type TerminalEntry = AgentEntry | VoiceTerminalEntry;
export declare function TerminalTranscriptSurface({ canLoadOlder, composer, entries, followTailRequest, inactiveMessage, isLoadingOlder, mode, showToolCalls, status, voiceEntries, welcome, onLoadOlder, }: {
    canLoadOlder: boolean;
    composer: ReactNode;
    entries: readonly AgentEntry[];
    followTailRequest?: number;
    inactiveMessage: string;
    isLoadingOlder: boolean;
    mode: AgentTerminalMode;
    showToolCalls?: boolean;
    status: AgentStatus;
    voiceEntries?: readonly VoiceTerminalEntry[];
    welcome?: string;
    onLoadOlder(): Promise<boolean>;
}): import("react").JSX.Element;
export declare function interleaveTranscriptEntries(entries: readonly AgentEntry[], voiceEntries: readonly VoiceTerminalEntry[]): readonly TerminalEntry[];
export {};
