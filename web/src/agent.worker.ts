import { Agent, Transport } from "nanocodex/browser";
import type { AgentTerminal, TerminalHost } from "nanocodex-terminal";
import type { DefaultAgent, EventWatcher } from "nanocodex";
import {
  createAgentController,
  type AgentControllerPayment,
  type AgentControllerStart,
  type AgentControllerTools,
} from "./agentController";
import type {
  PaymentStatus,
  WebTerminalCommand,
  WebWorkerCommand,
} from "./nanocodex";
import { createPaymentSessionOwner } from "./paymentSessionOwner";
import { MPP_RESPONSES_WEBSOCKET_URL } from "./tempo-constants";

type IncomingMessage = WebWorkerCommand | { type: "warmup" };
type PaymentSession = Awaited<ReturnType<(typeof import("./tempo"))["createTempoMppSession"]>>;
const CHATGPT_API_BASE_URL = "https://chatgpt.com/backend-api/codex";

type WorkerScope = {
  location: Location;
  onmessage: ((event: MessageEvent<IncomingMessage>) => void) | null;
  postMessage(message: unknown): void;
};

const worker = self as unknown as WorkerScope;
const paymentSessions = createPaymentSessionOwner<PaymentSession>();
const controller = createAgentController({
  createAgent,
  postMessage: (message) => worker.postMessage(message),
  logPaymentEvent: (event) => console.info(JSON.stringify(event)),
});
let attachedTerminal: AgentTerminal | undefined;
let terminalAgent: DefaultAgent | undefined;
let terminalEvents: EventWatcher | undefined;
let terminalHost: WorkerTerminalHost | undefined;
let commands = Promise.resolve();

worker.onmessage = ({ data }: MessageEvent<IncomingMessage>) => {
  if (data.type === "warmup") {
    commands = commands.then(() => Agent.prewarm()).catch((error) => {
      console.warn(error);
    });
    return;
  }
  if (data.type === "terminalInput") {
    terminalHost?.input(data.data);
    return;
  }
  if (data.type === "terminalResize") {
    terminalHost?.resize(data.cols, data.rows);
    return;
  }
  commands = commands
    .then(() => data.type === "start" && "surface" in data && data.surface === "terminal"
      ? startTerminal(data)
      : controller.handle(data))
    .catch((error) => {
      worker.postMessage({
        type: "fatal",
        message: errorMessage(error),
      });
    });
};

async function startTerminal(command: Extract<WebTerminalCommand, { type: "start" }>) {
  const { createAgentTerminal } = await import("nanocodex-terminal");
  attachedTerminal?.dispose();
  terminalEvents?.off();
  if (terminalAgent) await terminalAgent.session.shutdown();
  attachedTerminal = undefined;
  terminalEvents = undefined;
  terminalAgent = undefined;

  const images = new Map<string, string[]>();
  const created = await createAgent({
    thinking: command.thinking,
    reasoningMode: command.reasoningMode,
    threadId: command.threadId,
    transport: command.transport,
    ...(command.transport === "mpp"
      ? {
          accessKeyAddress: command.accessKeyAddress,
          payerAddress: command.payerAddress,
        }
      : {}),
  }, {
    recentImages(sessionId, count) {
      return (images.get(sessionId) ?? []).slice(-count);
    },
    rememberImage(sessionId, imageUrl) {
      const retained = images.get(sessionId) ?? [];
      retained.push(imageUrl);
      if (retained.length > 10) retained.splice(0, retained.length - 10);
      images.set(sessionId, retained);
    },
  });
  const payment = "payment" in created ? created.payment : undefined;
  terminalAgent = created.agent;
  terminalHost = createWorkerTerminalHost();
  attachedTerminal = createAgentTerminal({
    agent: created.agent,
    terminal: terminalHost.host,
    onEvent(event) {
      if (event.type === "prompt.completed") postPaymentStatus(payment);
    },
  });
  if (payment) {
    terminalEvents = created.agent.events.watch({ includeAllSessions: true });
    terminalEvents.onEvent((event) => {
      console.info(JSON.stringify(event));
      worker.postMessage({ type: "mppJsonl", line: JSON.stringify(event) });
      postPaymentStatus(payment);
    });
    postPaymentStatus(payment);
  }
  await attachedTerminal.ready;
  worker.postMessage({ type: "ready", sessionId: created.agent.sessionId });
}

type WorkerTerminalHost = {
  host: TerminalHost;
  input(data: string): void;
  resize(cols: number, rows: number): void;
};

function createWorkerTerminalHost(): WorkerTerminalHost {
  let cols = 80;
  let rows = 24;
  const dataListeners = new Set<(data: string) => void>();
  const resizeListeners = new Set<(size: { cols: number; rows: number }) => void>();
  return {
    host: {
      write(data) {
        worker.postMessage({
          type: "terminalWrite",
          data: typeof data === "string" ? data : new TextDecoder().decode(data),
        });
      },
      onData(listener) {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onResize(listener) {
        resizeListeners.add(listener);
        return () => resizeListeners.delete(listener);
      },
      get cols() { return cols; },
      get rows() { return rows; },
    },
    input(data) {
      for (const listener of dataListeners) listener(data);
    },
    resize(nextCols, nextRows) {
      if (!Number.isSafeInteger(nextCols) || !Number.isSafeInteger(nextRows)
        || nextCols <= 0 || nextRows <= 0) return;
      cols = nextCols;
      rows = nextRows;
      for (const listener of resizeListeners) listener({ cols, rows });
    },
  };
}

let lastPaymentStatus: string | undefined;
function postPaymentStatus(
  payment: AgentControllerPayment | undefined,
) {
  if (!payment) return;
  const status: PaymentStatus = {
    rootAddress: payment.rootAddress,
    accessKeyAddress: payment.accessKeyAddress(),
    channelId: payment.channelId,
    cumulative: payment.cumulative(),
    ...(payment.mcpCumulative
      ? { mcpCumulative: payment.mcpCumulative() }
      : {}),
  };
  const encoded = JSON.stringify(status);
  if (encoded === lastPaymentStatus) return;
  lastPaymentStatus = encoded;
  worker.postMessage({ type: "mppPayment", payment: status });
}

async function createAgent(
  start: AgentControllerStart,
  tools: AgentControllerTools,
) {
  await paymentSessions.clear();
  const origin = worker.location.origin;
  const toolHeaders = { "x-nanocodex-request": "1" };
  const [runtime, mcpModule] = await Promise.all([
    import("nanocodex/tools/browser").then(({ browser }) => browser({
      threadId: start.threadId!,
      origin,
      web: {
        url: new URL("/api/tools/web-search", origin),
        headers: toolHeaders,
      },
      images: {
        url: new URL("/api/tools/image-generation", origin),
        headers: toolHeaders,
      },
      recentImages: tools.recentImages,
      rememberImage: tools.rememberImage,
    })),
    import("./browserMcp"),
  ]);
  const common = {
    filesystem: runtime.filesystem,
    filesystemTools: false,
    instructions: runtime.instructions,
    executionEnvironment: browserExecutionEnvironment(runtime.projectInstructions),
    mcp: mcpModule.browserMcpConfiguration(origin),
    tools: runtime.tools,
    thinking: start.thinking,
    reasoningMode: start.reasoningMode,
  };
  if (start.transport === "mpp") {
    const payerAddress = start.payerAddress;
    const accessKeyAddress = start.accessKeyAddress;
    if (!payerAddress) {
      throw new Error("MPP requires a connected Tempo account");
    }
    if (!accessKeyAddress) {
      throw new Error("MPP requires a locally signable Tempo access key");
    }
    const { createTempoMppSession } = await import("./tempo");
    return paymentSessions.open(
      () => createTempoMppSession(payerAddress, accessKeyAddress),
      async (paymentSession) => {
        const agent = await Agent.create({
          ...common,
          fastMode: true,
          transport: Transport.mpp({
            session: paymentSession.provider,
            websocketUrl: MPP_RESPONSES_WEBSOCKET_URL,
          }),
        });
        return {
          agent,
          payment: {
            rootAddress: paymentSession.rootAddress,
            accessKeyAddress: paymentSession.accessKeyAddress,
            get channelId() {
              return paymentSession.mpp.channelId;
            },
            cumulative: () => paymentSession.mpp.cumulative.toString(),
            mcpCumulative: () => paymentSession.mcpCumulative().toString(),
          },
        };
      },
    );
  }
  const createWebSocket = (endpoint: string, sessionId: string) =>
    import("./workerManagedWebSocket").then(({ createWorkerManagedWebSocket }) =>
      createWorkerManagedWebSocket(endpoint, sessionId)
    );
  if (start.transport === "chatgpt") {
    return {
      agent: await Agent.create({
        ...common,
        transport: Transport.hostManaged({
          apiBaseUrl: CHATGPT_API_BASE_URL,
          websocketUrl: workerEndpoint(),
          createWebSocket,
        }),
      }),
    };
  }
  return {
    agent: await Agent.create({
      ...common,
      transport: Transport.openAi({
        apiKey: "worker-managed",
        websocketUrl: workerEndpoint(),
        createWebSocket,
      }),
    }),
  };
}

function browserExecutionEnvironment(projectInstructions?: string) {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currentDate = timezone
    ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    : now.toISOString().slice(0, 10);
  return {
    currentDate,
    timezone: timezone || "Etc/UTC",
    ...(projectInstructions === undefined ? {} : { projectInstructions }),
  };
}

function workerEndpoint(): string {
  const protocol = worker.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${worker.location.host}/api/responses`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
