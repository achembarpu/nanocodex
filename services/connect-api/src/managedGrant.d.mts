export type ManagedGrantAssertion = Readonly<{
  brokerUserId: string;
  capabilities: readonly string[];
  connectors: readonly string[];
  grantId: `0x${string}`;
  mcpIds: readonly string[];
}>;

export function managedAgentPortabilityGranted(capabilities: readonly string[]): boolean;
export function managedGrantHeaders(
  assertion: ManagedGrantAssertion,
): Record<string, string>;
