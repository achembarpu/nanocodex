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
const MACHINE_USD = "0x20c0000000000000000000006637932dE5413804" as const;
const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50" as const;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const LEGACY_CONVERSATION_ID = "legacy";

export const CHROME_ZERO_SPEND_LIMITS = [
  { token: MACHINE_USD, limit: 0n, period: 0 },
  { token: USDC_E, limit: 0n, period: 0 },
] as const;

export const CHROME_CONNECT_REQUEST = {
  capabilities: {
    agent: {
      finalMessages: true,
      actionSummaries: true,
      conversationHistory: true,
      rawTraces: true,
    },
    cloudAccounts: { chatgpt: true },
  },
  permission: "agent.run",
} as const;

type ConnectClient = ReturnType<typeof Client.create>;
const conversationClients = new Map<string, ConnectClient>();
const agentClients = new Map<string, ConnectClient>();

export async function connectNanocodex(conversationId = LEGACY_CONVERSATION_ID): Promise<Connection> {
  const client = clientForConversation(conversationId);
  const connection = await client.connection.connect(connectRequest(conversationId));
  agentClients.set(connection.agentId, client);
  return connection;
}

export async function reconnectNanocodex(conversationId = LEGACY_CONVERSATION_ID): Promise<Connection | undefined> {
  const client = clientForConversation(conversationId);
  const connection = await client.connection.reconnect(connectRequest(conversationId));
  if (!connection || isManagedAgentId(connection.agentId)) {
    if (connection) agentClients.set(connection.agentId, client);
    return connection;
  }
  await client.connection.disconnect();
  return undefined;
}

export function disconnectNanocodex(conversationId = LEGACY_CONVERSATION_ID): Promise<void> {
  return clientForConversation(conversationId).connection.disconnect();
}

export function createConnectedAgent(
  connection: Connection,
  tools: readonly NamedTool[],
  signal?: AbortSignal,
): Promise<ConnectAgent> {
  const client = agentClients.get(connection.agentId);
  if (!client) throw new Error("The durable conversation session is unavailable.");
  return client.agent.create({ connection, tools, signal });
}

export function createConversationId(): string {
  return crypto.randomUUID();
}

export function isConversationId(value: string): boolean {
  return value === LEGACY_CONVERSATION_ID || CONVERSATION_ID.test(value);
}

function clientForConversation(conversationId: string): ConnectClient {
  if (!isConversationId(conversationId)) throw new TypeError("Invalid durable conversation identifier.");
  const retained = conversationClients.get(conversationId);
  if (retained) return retained;
  const now = Math.floor(Date.now() / 1_000);
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
        expiry: now + 30 * 86_400,
        reuse: {
          minExpiry: now + 7 * 86_400,
          minLimits: CHROME_ZERO_SPEND_LIMITS,
        },
        limits: CHROME_ZERO_SPEND_LIMITS,
        scopes: [],
      },
    },
    dialog: Dialog.popup({
      host: CONNECT_DIALOG,
      key: `nanocodex-chrome-${conversationId}`,
      name: "Nanocodex Connect",
    }),
    session: conversationId === LEGACY_CONVERSATION_ID
      ? undefined
      : conversationStorage(conversationId),
    transport: Transport.http(CONNECT_API, {
      credentials: "omit",
      key: `nanocodex-chrome-${conversationId}`,
      name: "Nanocodex Connect API",
    }),
  });
  conversationClients.set(conversationId, client);
  return client;
}

function connectRequest(conversationId: string) {
  return {
    ...CHROME_CONNECT_REQUEST,
    ...(conversationId === LEGACY_CONVERSATION_ID ? {} : { conversationId }),
  } as const;
}

function conversationStorage(conversationId: string): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const prefix = `nanocodex:chrome:conversation:${conversationId}:`;
  return {
    getItem: (key) => localStorage.getItem(`${prefix}${key}`),
    setItem: (key, value) => localStorage.setItem(`${prefix}${key}`, value),
    removeItem: (key) => localStorage.removeItem(`${prefix}${key}`),
  };
}

export function isManagedAgentId(value: string): boolean {
  return MANAGED_AGENT_ID.test(value);
}

export type { Connection as NanocodexConnection };
