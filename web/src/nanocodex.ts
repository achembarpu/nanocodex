import { createConfig } from "nanocodex-react";
import type { TuiCommand, TuiMessage, TuiTarget } from "nanocodex-tui";
import type { Address } from "viem";
import { createPrewarmedWorkerOwner } from "./agentTerminalLifecycle";

export type AgentTransport = "openai" | "mpp";
type StartCommand = Extract<TuiCommand, { type: "start" }>;
export type WebTuiCommand =
  | Exclude<TuiCommand, { type: "start" }>
  | { type: "artifactPrompt"; id: number; prompt: string }
  | (StartCommand & { threadId: string; transport: "openai" })
  | (StartCommand & { threadId: string; transport: "chatgpt" })
  | (StartCommand & {
      accessKeyAddress: Address;
      payerAddress: Address;
      threadId: string;
      transport: "mpp";
    });
export type PaymentStatus = {
  rootAddress: string;
  accessKeyAddress?: string;
  channelId?: string;
  cumulative: string;
  mcpCumulative?: string;
};
export type WebTuiMessage = TuiMessage
  | { type: "mppPayment"; payment: PaymentStatus }
  | { type: "mppJsonl"; line: string };
export type WebTerminalCommand =
  | (Extract<WebTuiCommand, { type: "start" }> & { surface: "terminal" })
  | { type: "terminalInput"; data: string }
  | { type: "terminalSubmit"; input: string; intent: "queue" | "steer" }
  | { type: "terminalCancel" }
  | { type: "terminalResize"; cols: number; rows: number };
export type WebWorkerCommand = WebTuiCommand | WebTerminalCommand;
export type WebWorkerMessage = WebTuiMessage
  | { type: "terminalWrite"; data: string }
  | { type: "terminalActivity"; running: boolean };

function createAgentWorker() {
  return new Worker(new URL("./agent.worker.ts", import.meta.url), { type: "module" });
}

const agentWorkers = createPrewarmedWorkerOwner(createAgentWorker);

export function prewarmNanocodexWorker() {
  agentWorkers.prewarm();
}

/** Website-owned wiring for the publishable React package. */
export const nanocodexConfig = createConfig<WebWorkerCommand, WebWorkerMessage>({
  autoStart: false,
  worker: agentWorkers.claim,
});
