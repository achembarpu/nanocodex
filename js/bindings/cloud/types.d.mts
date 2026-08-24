export type Hex = `0x${string}`;

export type CloudAccount = "github" | "gmail" | "gdrive" | "chatgpt";

export type AccessKey = Readonly<{
  address: Hex;
  chainId: bigint;
  keyId: Hex;
  /** Public key material is present only when the caller supplied an external key. */
  publicKey?: Hex | undefined;
  keyType: "secp256k1" | "p256" | "webAuthn";
  limits: readonly Readonly<{ token: Hex; limit: bigint; period?: number | undefined }>[];
  scopes: readonly Readonly<{
    address: Hex;
    selector?: Hex | string | undefined;
    recipients?: readonly Hex[] | undefined;
  }>[];
  witness: Hex;
  expiry: number;
  /** Canonical RLP-encoded, root-signed TIP-1053 authorization. */
  authorization?: Hex | undefined;
}>;

export type AgentTurnResult = Readonly<{
  turnId: string | undefined;
  finalMessage: string;
  provider: string;
  capabilitiesUsed: readonly string[];
  usage: import("../types.mjs").TurnUsage;
}>;

export type AgentTurn = Readonly<{
  accepted: Promise<string | undefined>;
  result(): Promise<AgentTurnResult>;
  cancel(): Promise<void>;
}>;

export type ConnectAgent = Readonly<{
  id: string;
  type: "connect";
  provider: string;
  mercator: Readonly<{
    enabled: true;
    readonly channelId: Hex | undefined;
    readonly cumulative: bigint;
    readonly opened: boolean;
  }>;
  turn: Readonly<{
    prompt(options: Readonly<{ input: string; signal?: AbortSignal | undefined }>): AgentTurn;
  }>;
  session: Readonly<{ shutdown(): Promise<void> }>;
}>;

export type Grant = Readonly<{
  id: Hex;
  permission: string;
  status: "active" | "revoked" | "expired";
  expiresAt: number;
  capabilities: readonly string[];
  /** Secret-free cloud account providers bound to this grant. */
  connectors: readonly CloudAccount[];
}>;

export type MppPermission = Readonly<{
  token: Hex;
  symbol: string;
  balance: bigint;
  settlementToken: Hex;
  settlementSymbol: string;
  settlementBalance: bigint;
  spent: bigint;
  limit: bigint;
  period: number;
  maxPerRequest: bigint;
}>;

export type Connection = Readonly<{
  accountAddress: Hex;
  agentId: string;
  grant: Grant;
  accessKey: AccessKey;
  mpp: MppPermission;
}>;

export type MachineUsdConfig = Readonly<{
  chainId: number;
  minUsdAmountCents: number;
  maxUsdAmountCents: number;
  onrampEnabled: boolean;
  stripePublishableKey: string;
  tokenAddress: Hex;
}>;

export type MachineUsdFunding = Readonly<{
  order: Readonly<{
    id: string;
    status: string;
    usdAmountCents: number;
    machineUsdAmount: bigint;
    issuanceTransactionHash: Hex;
  }>;
  connection: Connection;
}>;

export type MppCharge = Readonly<{
  receipt: Readonly<{
    id: string;
    amount: bigint;
    origin: string;
    transactionHash: Hex;
  }>;
  connection: Connection;
}>;
