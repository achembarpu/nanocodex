import type { PromptInput } from "nanocodex";

const CONNECTOR_IDS = ["github", "gmail", "gdrive"] as const;

type ConnectorId = typeof CONNECTOR_IDS[number];
type BrokerBinding = Readonly<{
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}>;

export type AccountInfo = Readonly<{
  status: "disabled" | "ready" | "unavailable";
  authenticated: readonly ConnectorId[];
  accounts: Readonly<Partial<Record<ConnectorId, string>>>;
  identity: Readonly<Record<string, never>>;
  stablecoins: readonly [];
  authorizations: readonly [];
}>;

export async function accountInfo(
  binding: BrokerBinding,
  userId: string,
  enabled: boolean,
): Promise<AccountInfo> {
  if (!enabled) return emptyInfo("disabled");
  try {
    const response = await binding.fetch(
      `https://broker.internal/users/${encodeURIComponent(userId)}/connectors`,
    );
    if (!response.ok) {
      await response.body?.cancel();
      return emptyInfo("unavailable");
    }
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.connectors)) {
      return emptyInfo("unavailable");
    }
    const connectors = value.connectors;
    const accounts: Partial<Record<ConnectorId, string>> = {};
    const authenticated = CONNECTOR_IDS.filter((id) => {
      const connector = connectors[id];
      if (!isRecord(connector) || connector.connected !== true) return false;
      if (typeof connector.label === "string" && connector.label.trim()) {
        accounts[id] = connector.label.trim();
      }
      return true;
    });
    return {
      status: "ready",
      authenticated,
      accounts,
      identity: {},
      stablecoins: [],
      authorizations: [],
    };
  } catch {
    return emptyInfo("unavailable");
  }
}

export function withInitialAccountInfo(input: PromptInput, info: AccountInfo): PromptInput {
  const explanation = [
    "The managed runtime already resolved the following non-secret accountInfo snapshot for",
    "this agent. Use it as the current connected-account context. Do not call accountInfo",
    "again unless the task requires state refreshed after this first prompt.",
  ].join(" ");
  const context = {
    type: "text" as const,
    text: `${explanation}\n\n<account_info>\n${JSON.stringify(info)}\n</account_info>`,
  };
  return typeof input === "string"
    ? [context, { type: "text", text: input }]
    : [context, ...input];
}

function emptyInfo(status: "disabled" | "unavailable"): AccountInfo {
  return {
    status,
    authenticated: [],
    accounts: {},
    identity: {},
    stablecoins: [],
    authorizations: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
