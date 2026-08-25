import { type ReactNode } from "react";
import { type Agent, type AgentControllerEvent } from "nanocodex-react/agent";
import type { AgentStatus, AgentTerminalMode, AgentTerminalState } from "./types.js";
export type AgentTerminalAccessory = Readonly<{
    agentReady: boolean;
    submit(input: string): void;
}>;
/** Shared website terminal presentation. Runtime and authorization policy stay with its consumer. */
export declare function AgentTerminalView({ accessory, agent, agentError, controls, inactiveMessage, maxEntries, mode, onConversationActivity, onTerminalEvent, onStateChange, retryAgent, showToolCalls, welcome, }: {
    accessory?(controls: AgentTerminalAccessory): ReactNode;
    agent: Agent | undefined;
    agentError: string | undefined;
    controls?(controls: Pick<AgentTerminalAccessory, "agentReady">): ReactNode;
    inactiveMessage?(state: Readonly<{
        agentError: string | undefined;
        agentStatus: AgentStatus;
    }>): string | undefined;
    maxEntries?: number;
    mode: AgentTerminalMode;
    onConversationActivity(input: string): void;
    onTerminalEvent?(event: AgentControllerEvent): void;
    onStateChange(state: AgentTerminalState): void;
    retryAgent(): void;
    showToolCalls?: boolean;
    welcome?: string;
}): import("react").JSX.Element;
