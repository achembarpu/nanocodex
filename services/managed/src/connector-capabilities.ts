const CONNECTOR_IDS = ["github", "gmail", "gdrive"] as const;

type ConnectorId = typeof CONNECTOR_IDS[number];
type BrokerBinding = Readonly<{
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}>;

export type ConnectorEgressInfo = Readonly<{
  status: "disabled" | "ready" | "unavailable";
  authenticated: readonly ConnectorId[];
}>;

export async function connectorEgressInfo(
  binding: BrokerBinding,
  userId: string,
  enabled: boolean,
): Promise<ConnectorEgressInfo> {
  if (!enabled) return { status: "disabled", authenticated: [] };
  try {
    const response = await binding.fetch(
      `https://broker.internal/users/${encodeURIComponent(userId)}/connectors`,
    );
    if (!response.ok) {
      await response.body?.cancel();
      return { status: "unavailable", authenticated: [] };
    }
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.connectors)) {
      return { status: "unavailable", authenticated: [] };
    }
    const connectors = value.connectors;
    const authenticated = CONNECTOR_IDS.filter((id) => {
      const connector = connectors[id];
      return isRecord(connector) && connector.connected === true;
    });
    return { status: "ready", authenticated };
  } catch {
    return { status: "unavailable", authenticated: [] };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
