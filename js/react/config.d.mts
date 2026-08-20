import type { ReasoningMode, Thinking } from "nanocodex";

export type WorkerMessage = { type: string; [key: string]: unknown };
export type WorkerCommand = { type: string; [key: string]: unknown };
export type Status = "idle" | "starting" | "ready" | "stopped" | "error";

export type Snapshot = Readonly<{
  status: Status;
  error?: string;
}>;

export type WorkerLike<
  Command extends WorkerCommand = WorkerCommand,
  Message extends WorkerMessage = WorkerMessage,
> = {
  onmessage: ((event: MessageEvent<Message>) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: Command): void;
  terminate(): void;
};

export type Config<
  Command extends WorkerCommand = WorkerCommand,
  Message extends WorkerMessage = WorkerMessage,
> = Readonly<{
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  subscribeMessages(listener: (message: Message) => void): () => void;
  mount(): () => void;
  dispatch(command: Command): void;
  start(command?: Command): void;
  restart(command?: Command): void;
  disconnect(): void;
  stop(): void;
}>;

export type CreateConfigParameters<
  Command extends WorkerCommand = WorkerCommand,
  Message extends WorkerMessage = WorkerMessage,
> = {
  worker(): WorkerLike<Command, Message>;
  /** Start the Worker on mount. Defaults to true. */
  autoStart?: boolean;
  thinking?: Thinking;
  reasoningMode?: ReasoningMode;
};

export function createConfig<
  Command extends WorkerCommand = WorkerCommand,
  Message extends WorkerMessage = WorkerMessage,
>(options: CreateConfigParameters<Command, Message>): Config<Command, Message>;
