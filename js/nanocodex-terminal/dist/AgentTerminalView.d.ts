import { type ReactNode } from "react";
import { type Agent, type AgentControllerEvent } from "nanocodex-react/agent";
import { useVoice, type UseVoiceParameters, type UseVoiceReturnType } from "nanocodex-react";
import type { AgentStatus, AgentTerminalMode, AgentTerminalState } from "./types.js";
export type AgentTerminalAccessory = Readonly<{
    agentReady: boolean;
    submit(input: string): void;
}>;
/** Shared website terminal presentation. Runtime and authorization policy stay with its consumer. */
export declare function AgentTerminalView({ accessory, agent, agentError, controls, inactiveMessage, maxEntries, mode, onConversationActivity, onTerminalEvent, onStateChange, promptIntent, retryAgent, showToolCalls, telemetry, voice, voiceSource, voiceOptions, welcome, }: {
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
    /** Emits package-owned performance marks and diagnostic logs. Disabled by default. */
    telemetry?: boolean;
    /** Enables the package-owned microphone control. */
    voice?: boolean;
    /** Canonical SDK resource used by voice controls when the structural Agent is not normalized. */
    voiceSource?: Exclude<Parameters<typeof useVoice>[0], undefined>;
    voiceOptions?: Omit<UseVoiceParameters, "enabled">;
    welcome?: string;
}): import("react").JSX.Element;
export declare function VoiceControl({ agentReady, voice, }: {
    agentReady: boolean;
    voice: UseVoiceReturnType;
}): import("react").JSX.Element;
