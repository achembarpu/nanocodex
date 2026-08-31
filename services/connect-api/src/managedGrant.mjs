const managedBaseCapabilities = ["agents:read", "agents:write", "tools:use"];
const managedOptionalCapabilities = ["history:read", "memory:read", "memory:write"];
const managedPortabilityGrantCapabilities = [
  "agent.durability.portability",
  "agent.history.read",
  "agent.trace.read",
];

export function managedAgentPortabilityGranted(capabilities) {
  const granted = new Set(capabilities);
  return managedPortabilityGrantCapabilities.every((capability) => granted.has(capability));
}

export function managedGrantHeaders(assertion) {
  const granted = new Set(assertion.capabilities);
  const portability = managedAgentPortabilityGranted(assertion.capabilities);
  return {
    "x-nanocodex-connect-user": assertion.brokerUserId,
    "x-nanocodex-connect-grant-id": assertion.grantId,
    "x-nanocodex-connect-capabilities": JSON.stringify([
      ...managedBaseCapabilities,
      ...managedOptionalCapabilities.filter((capability) => granted.has(capability)),
      ...(portability ? ["agents:portability"] : []),
    ]),
    "x-nanocodex-connect-connectors": JSON.stringify(assertion.connectors),
    "x-nanocodex-connect-mcp-ids": JSON.stringify(assertion.mcpIds),
    ...(assertion.appToolPolicy === undefined
      ? {}
      : { "x-nanocodex-connect-app-tool-policy": assertion.appToolPolicy }),
  };
}
