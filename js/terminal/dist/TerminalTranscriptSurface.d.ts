import { type ReactNode } from "react";
import type { AgentEntry } from "nanocodex-react/agent";
import type { AgentStatus, AgentTerminalMode } from "./types.js";
export declare function TerminalTranscriptSurface({ canLoadOlder, composer, entries, followTailRequest, inactiveMessage, isLoadingOlder, mode, showToolCalls, status, welcome, onLoadOlder, }: {
    canLoadOlder: boolean;
    composer: ReactNode;
    entries: readonly AgentEntry[];
    followTailRequest?: number;
    inactiveMessage: string;
    isLoadingOlder: boolean;
    mode: AgentTerminalMode;
    showToolCalls?: boolean;
    status: AgentStatus;
    welcome?: string;
    onLoadOlder(): Promise<boolean>;
}): import("react").JSX.Element;
