export const DEFAULT_HOST: "https://connect.nanocodex.xyz/embed";

export type Request = ConnectionRequest | FundingRequest;

export type ConnectionRequest = Readonly<{
  id: string;
  type: "connect";
  app: Readonly<{ id: string; name: string; origin: string }>;
  accountAddress: `0x${string}`;
  auth: Readonly<{
    /** EIP-4361 message whose exact bytes are bound by the access-key witness. */
    message: string;
    /** Connect capabilities echoed into the SIWE Resources field. */
    resources: readonly string[];
  }>;
  permission: Readonly<{
    id: string;
    title: string;
    description: string;
    connectors: readonly Readonly<{ id: string; name: string; detail: string }>[];
  }>;
  accessKey: Readonly<{
    address: `0x${string}`;
    chainId: bigint;
    keyId: `0x${string}`;
    publicKey: `0x${string}`;
    keyType: "secp256k1" | "p256" | "webAuthn";
    witness: `0x${string}`;
    expiry: number;
    limits: readonly Readonly<{
      token: `0x${string}`;
      limit: bigint;
      period?: number | undefined;
    }>[];
    scopes: readonly Readonly<{
      address: `0x${string}`;
      selector?: `0x${string}` | string | undefined;
      recipients?: readonly `0x${string}`[] | undefined;
    }>[];
  }>;
  mpp: Readonly<{
    token: `0x${string}`;
    symbol: string;
    limit: bigint;
    period: number;
    maxPerRequest: bigint;
  }>;
}>;

export type FundingRequest = Readonly<{
  id: string;
  type: "machineUsdFund";
  accountAddress?: `0x${string}` | undefined;
  grantId: `0x${string}`;
  chainId: number;
  apiUrl: string;
  stripePublishableKey: string;
  tokenAddress: `0x${string}`;
  usdAmountCents: number;
}>;

export type Instance = Readonly<{
  host: string;
  open(request: Request): Promise<unknown>;
  /** Internal WATA iframe target used by the bundled Accounts provider. */
  walletTarget?(options: Readonly<{ host?: string | undefined }>): Window | null | undefined;
  showWallet?(): void;
  hideWallet?(): void;
  getRequest?(): Request | undefined;
  subscribe?(listener: () => void): () => void;
  respond?(result: unknown): void;
  reject?(error?: unknown): void;
}>;

export type Dialog<type extends string = string> = Readonly<{
  key: string;
  name: string;
  type: type;
  setup(options: Readonly<{ appId: string }>): Instance;
}>;

export function from<const type extends string>(parameters: Readonly<{
  key: string;
  name: string;
  type: type;
  setup(options: Readonly<{ appId: string }>): Instance;
}>): Dialog<type>;

export function iframe(options?: Readonly<{
  host?: string | undefined;
  key?: string | undefined;
  name?: string | undefined;
}>): Dialog<"iframe">;

export function memory(options?: Readonly<{
  host?: string | undefined;
  key?: string | undefined;
  name?: string | undefined;
}>): Dialog<"memory">;
