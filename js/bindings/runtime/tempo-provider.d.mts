import type { McpPayment, McpServers, MppSession } from "../types.mjs";

export declare const DEFAULT_MERCATOR_MCP_URL = "https://mercator.tempoxyz.dev/mcp";

export type TempoProvider<Session extends MppSession = MppSession> = MppSession & Readonly<{
  kind: "tempo";
  /** The underlying session, available for channel and payment telemetry. */
  session: Session;
}>;

export function createTempoProvider<Session extends MppSession>(
  options: { session: Session; payment: McpPayment },
): TempoProvider<Session>;

type WalletParameters = {
  getClient: (...args: any[]) => any;
  resolveAccount: (...args: any[]) => any;
};

/** The adapter-neutral surface implemented by every Accounts SDK provider. */
export type AccountsWallet = {
  getMppxParameters(options?: { accessKey?: `0x${string}` | undefined }): WalletParameters;
};

export type AccountsTempoPolicy = {
  /**
   * These values stay structurally typed so a wallet may use any compatible
   * Accounts/MPPx/Viem dependency instance without nominal package coupling.
   */
  autoSwap?: unknown;
  channelStore?: unknown;
  decimals?: number | undefined;
  escrow?: `0x${string}` | undefined;
  maxDeposit?: string | undefined;
  topUpAmount?: string | undefined;
  [option: string]: unknown;
};

export type AccountsTempoSessionOptions = AccountsTempoPolicy & {
  bootstrap?: boolean | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  webSocket?: unknown;
};

export type AccountsTempoMercatorOptions = AccountsTempoPolicy & {
  onChannelUpdate?: ((entry: {
    channelId: `0x${string}`;
    cumulativeAmount: bigint;
    [field: string]: unknown;
  }) => void | Promise<void>) | undefined;
};

export type AccountsTempoSession = MppSession & {
  readonly channelId: `0x${string}` | undefined;
  readonly cumulative: bigint;
  readonly opened: boolean;
  readonly state: unknown;
  close(): Promise<unknown>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  topUp(amount: string | bigint): Promise<unknown>;
};

export type AccountsTempoProviderOptions = {
  /** Any provider returned by Accounts SDK `Provider.create(...)`. */
  wallet: AccountsWallet;
  /** Optional Accounts SDK access key to pin for both model and MCP payments. */
  accessKey?: `0x${string}` | undefined;
  /** Shared Tempo payment policy applied to the model session and Mercator. */
  policy?: AccountsTempoPolicy | undefined;
  /** Model-session-only overrides, such as `bootstrap` or `webSocket`. */
  session?: AccountsTempoSessionOptions | undefined;
  /** Mercator-only Tempo method overrides, such as `onChannelUpdate`. */
  mercator?: AccountsTempoMercatorOptions | undefined;
};

/**
 * Constructs a Tempo provider from any Accounts SDK wallet adapter without
 * taking a runtime dependency on `accounts`.
 */
export function createTempoProviderFromAccounts(
  options: AccountsTempoProviderOptions,
): Promise<TempoProvider<AccountsTempoSession>>;

/** @internal */
export function resolveMcpServers(
  provider: MppSession | undefined,
  configured: McpServers | false | undefined,
): McpServers | undefined;
