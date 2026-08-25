import { type ReactNode } from "react";
import { type Agent, type AgentControllerEvent } from "nanocodex-react/agent";
import { type UseVoiceParameters } from "nanocodex-react";
import type { AgentStatus, AgentTerminalMode, AgentTerminalState } from "./types.js";
export type AgentTerminalAccessory = Readonly<{
    agentReady: boolean;
    submit(input: string): void;
}>;
/** Shared website terminal presentation. Runtime and authorization policy stay with its consumer. */
export declare function AgentTerminalView({ accessory, agent, agentError, controls, inactiveMessage, maxEntries, mode, onConversationActivity, onTerminalEvent, onStateChange, promptIntent, retryAgent, showToolCalls, voice, voiceOptions, welcome, }: {
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
    promptIntent?: "queue" | "steer";
    retryAgent(): void;
    showToolCalls?: boolean;
    /** Enables the package-owned microphone control. */
    voice?: boolean;
    voiceOptions?: Omit<UseVoiceParameters, "enabled">;
    welcome?: string;
}): import("react").JSX.Element;
