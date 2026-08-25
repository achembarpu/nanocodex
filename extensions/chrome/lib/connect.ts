import { Client, Dialog, Transport, type Connection } from "nanocodex/connect";

const CONNECT_API = "https://nanocodex-connect-api.gakonst.workers.dev";
const CONNECT_DIALOG = "https://nanocodex.gakonst.workers.dev/connect-dialog/";

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
        finalMessages: false,
        actionSummaries: false,
        conversationHistory: false,
        rawTraces: false,
      },
      cloudAccounts: { x: true, chatgpt: true },
    },
    permission: "agent.run",
  });
}

export function reconnectNanocodex(): Promise<Connection | undefined> {
  return client.connection.reconnect();
}

export function disconnectNanocodex(): Promise<void> {
  return client.connection.disconnect();
}

export function connectModelTransport(connection: Connection) {
  return client.model.transport({ connection });
}

export type { Connection as NanocodexConnection };
