import type { AgentStatus } from "./types.js";
export type ConversationSummary = Readonly<{
    id: string;
    title: string;
    updatedAt?: number;
    turnCount?: number;
}>;
export declare const ConversationHistoryRail: import("react").NamedExoticComponent<{
    agentStatus: AgentStatus;
    conversations: readonly ConversationSummary[];
    error?: string;
    mobileOpen: boolean;
    onClose(): void;
    onCreate?(): void;
    onOpen(): void;
    onRetry(): void;
    onSelect(id: string): void;
    pending: boolean;
    runtime: "local" | "managed";
    selectedId?: string;
}>;
