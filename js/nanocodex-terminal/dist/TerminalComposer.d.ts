import { type ReactNode } from "react";
import type { AgentStatus } from "./types.js";
/** One native, paste-capable composer shared by desktop and touch terminals. */
export declare function TerminalComposer({ controls, draft, pending, running, status, onCancel, onChange, onSubmit, }: {
    controls?: ReactNode;
    draft: string;
    pending: boolean;
    running: boolean;
    status: AgentStatus;
    onCancel(): void;
    onChange(value: string): void;
    onSubmit(value: string): void;
}): import("react").JSX.Element;
