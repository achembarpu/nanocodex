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

/** @internal */
export function resolveMcpServers(
  provider: MppSession | undefined,
  configured: McpServers | false | undefined,
): McpServers | undefined;
