import { createConfig } from "nanocodex-react";
import type { TuiCommand, TuiMessage, TuiTarget } from "nanocodex-tui";
import type { Address } from "viem";

export type AgentTransport = "openai" | "mpp";
type StartCommand = Extract<TuiCommand, { type: "start" }>;
export type WebTuiCommand =
  | Exclude<TuiCommand, { type: "start" }>
  | { type: "artifactPrompt"; id: number; prompt: string }
  | { type: "voicePrompt"; target: TuiTarget; id: number; prompt: string }
  | { type: "voiceTranscript"; target: TuiTarget; speaker: "user" | "assistant"; text: string }
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

let prewarmedWorker: Worker | undefined;
let workerClaimed = false;

function createAgentWorker() {
  return new Worker(new URL("./agent.worker.ts", import.meta.url), { type: "module" });
}

export function prewarmNanocodexWorker() {
  if (workerClaimed) return;
  prewarmedWorker ??= createAgentWorker();
  prewarmedWorker.postMessage({ type: "warmup" });
}

/** Website-owned wiring for the publishable React package. */
export const nanocodexConfig = createConfig<WebTuiCommand, WebTuiMessage>({
  autoStart: false,
  worker: () => {
    workerClaimed = true;
    const worker = prewarmedWorker ?? createAgentWorker();
    prewarmedWorker = undefined;
    return worker;
  },
});
