import { Agent } from "nanocodex/browser";
import {
  createAgentController,
  type AgentControllerStart,
  type AgentControllerTools,
} from "./agentController";
import { createBrowserTools } from "./browserTools";
import type { WebTuiCommand } from "./nanocodex";
import { createPaymentSessionOwner } from "./paymentSessionOwner";
import { MPP_RESPONSES_WEBSOCKET_URL } from "./tempo-constants";

type IncomingMessage = WebTuiCommand | { type: "warmup" };
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
let commands = Promise.resolve();

worker.onmessage = ({ data }: MessageEvent<IncomingMessage>) => {
  if (data.type === "warmup") {
    commands = commands.then(() => Agent.prewarm()).catch((error) => {
      console.warn(error);
    });
    return;
  }
  commands = commands
    .then(() => controller.handle(data))
    .catch((error) => {
      worker.postMessage({
        type: "fatal",
        message: errorMessage(error),
      });
    });
};

async function createAgent(
  start: AgentControllerStart,
  tools: AgentControllerTools,
) {
  await paymentSessions.clear();
  const { execTool, instructions, workspace } = await (await import("./browserShell"))
    .prepareBrowserShell(start.threadId!, self.location.origin);
  const common = {
    filesystem: workspace,
    filesystemTools: false,
    instructions,
    tools: {
      exec_command: execTool,
      ...createBrowserTools({
        recentImages: tools.recentImages,
        rememberImage: tools.rememberImage,
      }),
    },
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
          mpp: paymentSession.provider,
          websocketUrl: MPP_RESPONSES_WEBSOCKET_URL,
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
        hostAuth: true,
        apiBaseUrl: CHATGPT_API_BASE_URL,
        websocketUrl: workerEndpoint(),
        createWebSocket,
      }),
    };
  }
  return {
    agent: await Agent.create({
      ...common,
      apiKey: "worker-managed",
      websocketUrl: workerEndpoint(),
      createWebSocket,
    }),
  };
}

function workerEndpoint(): string {
  const protocol = self.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${self.location.host}/api/responses`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
