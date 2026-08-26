export const mcpResourcePrefix: string;
export const mcpFocusResourcePrefix: string;
export function isMcpConnectionId(value: unknown): value is string;
export function mcpConnectionIds(resources: unknown): readonly string[];
export function focusedMcpConnectionIds(resources: unknown): readonly string[];
export function isAllowedMcpResource(resource: unknown): boolean;
export function validateMcpResources(resources: unknown): Readonly<{
  requested: readonly string[];
  focus?: string;
}>;
export function canonicalRemoteMcpTarget(value: unknown): Readonly<{
  endpoint: string;
  name: string;
}>;
