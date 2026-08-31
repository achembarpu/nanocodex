import {
  Client,
  Dialog,
  Transport,
  type ConnectAgent,
  type Connection,
} from "nanocodex/connect";
import type { NamedTool } from "nanocodex/host";

const CONNECT_API = "https://nanocodex-connect-api.gakonst.workers.dev";
const CONNECT_DIALOG = "https://nanocodex.gakonst.workers.dev/connect-dialog/";
const MANAGED_AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const client = Client.create({
  appId: "nanocodex-chrome",
  auth: {
    challenge: `${CONNECT_API}/v1/connect/auth/challenge`,
    verify: `${CONNECT_API}/v1/connect/auth`,
    logout: `${CONNECT_API}/v1/connect/auth/logout`,
    resources: ["urn:nanocodex:agent:run"],
    returnToken: true,
  },
  accessKey: {
    authorize: {
      expiry: Math.floor(Date.now() / 1_000) + 30 * 86_400,
      reuse: { minExpiry: Math.floor(Date.now() / 1_000) + 7 * 86_400 },
      limits: [],
      scopes: [],
    },
  },
  dialog: Dialog.popup({
    host: CONNECT_DIALOG,
    key: "nanocodex-chrome",
    name: "Nanocodex Connect",
  }),
  transport: Transport.http(CONNECT_API, {
    credentials: "omit",
    key: "nanocodex-chrome",
    name: "Nanocodex Connect API",
  }),
});

export function connectNanocodex(): Promise<Connection> {
  return client.connection.connect({
    capabilities: {
      agent: {
        finalMessages: true,
        actionSummaries: false,
        conversationHistory: false,
        rawTraces: false,
      },
      cloudAccounts: { chatgpt: true },
    },
    permission: "agent.run",
  });
}

export async function reconnectNanocodex(): Promise<Connection | undefined> {
  const connection = await client.connection.reconnect();
  if (!connection || isManagedAgentId(connection.agentId)) return connection;
  await client.connection.disconnect();
  return undefined;
}

export function disconnectNanocodex(): Promise<void> {
  return client.connection.disconnect();
}

export function createConnectedAgent(
  connection: Connection,
  tools: readonly NamedTool[],
  signal?: AbortSignal,
): Promise<ConnectAgent> {
  return client.agent.create({ connection, tools, signal });
}

export function isManagedAgentId(value: string): boolean {
  return MANAGED_AGENT_ID.test(value);
}

export type { Connection as NanocodexConnection };
