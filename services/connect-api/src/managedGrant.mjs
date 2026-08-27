const managedBaseCapabilities = ["agents:read", "agents:write", "tools:use"];
const managedOptionalCapabilities = ["history:read", "memory:read", "memory:write"];

export function managedGrantHeaders(assertion) {
  const granted = new Set(assertion.capabilities);
  return {
    "x-nanocodex-connect-user": assertion.brokerUserId,
    "x-nanocodex-connect-grant-id": assertion.grantId,
    "x-nanocodex-connect-capabilities": JSON.stringify([
      ...managedBaseCapabilities,
      ...managedOptionalCapabilities.filter((capability) => granted.has(capability)),
    ]),
    "x-nanocodex-connect-connectors": JSON.stringify(assertion.connectors),
    "x-nanocodex-connect-mcp-ids": JSON.stringify(assertion.mcpIds),
  };
}
