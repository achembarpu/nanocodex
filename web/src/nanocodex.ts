import { createConfig } from "nanocodex-react";
import type { TuiCommand, TuiMessage } from "nanocodex-tui";
import type { Address } from "viem";
import type { ArtifactDocument } from "./artifact";

export type AgentTransport = "openai" | "mpp";
type StartCommand = Extract<TuiCommand, { type: "start" }>;
export type WebTuiCommand =
  | Exclude<TuiCommand, { type: "start" }>
  | { type: "artifactPrompt"; id: number; prompt: string }
  | (StartCommand & { transport: "openai" })
  | (StartCommand & { transport: "chatgpt" })
  | (StartCommand & {
      accessKeyAddress: Address;
      payerAddress: Address;
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
  | { type: "mppJsonl"; line: string }
  | { type: "artifact"; artifact: ArtifactDocument };

/** Website-owned wiring for the publishable React package. */
export const nanocodexConfig = createConfig<WebTuiCommand, WebTuiMessage>({
  autoStart: false,
  worker: () => new Worker(new URL("./agent.worker.ts", import.meta.url), { type: "module" }),
});
