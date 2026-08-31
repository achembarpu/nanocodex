export const cliApp: Readonly<{
  id: "nanocodex-cli";
  name: "Nanocodex CLI";
  origin: "https://cli.nanocodex.xyz";
}>;
export const cliAppResource: string;
export const cliOriginResource: string;
export const agentPortabilityResource: "urn:nanocodex:agent:durability:portability";
export function parseCliWalletRequest(value: unknown): Readonly<{
  id: string | number;
  method: "wallet_connect";
  params: readonly unknown[];
  resources: readonly string[];
}>;
export function parseCliRegisterBody(value: unknown): ReturnType<typeof parseCliWalletRequest>;
export function approvedCliAccessKeyMatches(
  pending: unknown,
  approved: unknown,
): boolean;
export function sanitizeCliWalletResult(value: unknown): Readonly<{
  accounts: readonly Readonly<{
    address: `0x${string}`;
    capabilities: Readonly<{
      keyAuthorization: Readonly<Record<string, unknown>>;
      personalSign: Readonly<{ keyAuthorization: `0x${string}` }>;
      auth: Readonly<{ approval_id: string }>;
    }> | Readonly<{
      auth: Readonly<{ approval_id: string; mode: "hosted" }>;
    }>;
  }>[];
}>;
export function managedMemoryCapability(
  path: string,
  operation?: unknown,
): "history:read" | "memory:read" | "memory:write" | undefined;
export function requestedConnectorsSatisfied(
  connected: readonly string[],
  requested: readonly string[],
): boolean;
