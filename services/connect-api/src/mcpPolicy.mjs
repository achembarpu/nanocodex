const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRIVATE_SUFFIXES = [".internal", ".invalid", ".local", ".localhost", ".test", ".home.arpa"];

export const mcpResourcePrefix = "urn:nanocodex:mcp:";
export const mcpFocusResourcePrefix = "urn:nanocodex:mcp-focus:";

export function isMcpConnectionId(value) {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

export function mcpConnectionIds(resources) {
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((resource) => (
    typeof resource === "string" && resource.startsWith(mcpResourcePrefix)
      ? [resource.slice(mcpResourcePrefix.length)]
      : []
  )).filter(isMcpConnectionId);
}

export function focusedMcpConnectionIds(resources) {
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((resource) => (
    typeof resource === "string" && resource.startsWith(mcpFocusResourcePrefix)
      ? [resource.slice(mcpFocusResourcePrefix.length)]
      : []
  )).filter(isMcpConnectionId);
}

export function isAllowedMcpResource(resource) {
  if (typeof resource !== "string") return false;
  if (resource.startsWith(mcpResourcePrefix)) {
    return isMcpConnectionId(resource.slice(mcpResourcePrefix.length));
  }
  if (resource.startsWith(mcpFocusResourcePrefix)) {
    return isMcpConnectionId(resource.slice(mcpFocusResourcePrefix.length));
  }
  return false;
}

export function validateMcpResources(resources) {
  const requested = mcpConnectionIds(resources);
  const focused = focusedMcpConnectionIds(resources);
  if (new Set(requested).size !== requested.length
    || focused.length > 1
    || (focused[0] !== undefined && !requested.includes(focused[0]))) {
    throw new Error("The CLI MCP connection resources are invalid.");
  }
  return Object.freeze({
    requested: Object.freeze([...requested]),
    focus: focused[0],
  });
}

export function canonicalRemoteMcpTarget(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new Error("Remote MCP target must be a bounded public host or HTTPS URL.");
  }
  let endpoint;
  if (value.startsWith("https://")) {
    try { endpoint = new URL(value); } catch { throw new Error("Remote MCP target is invalid."); }
  } else {
    if (!value.startsWith("mcp.") || !DNS_NAME.test(value)) {
      throw new Error("Remote MCP shorthand must be a public mcp.* host.");
    }
    endpoint = new URL(`https://${value}/mcp`);
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash
    || !DNS_NAME.test(hostname) || hostname === "localhost"
    || PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error("Remote MCP target must use a public HTTPS endpoint.");
  }
  if (endpoint.port && endpoint.port !== "443") {
    throw new Error("Remote MCP target cannot use a custom port.");
  }
  endpoint.hostname = hostname;
  endpoint.port = "";
  if (endpoint.pathname === "/") endpoint.pathname = "/mcp";
  if (endpoint.pathname.length > 1_024) throw new Error("Remote MCP target is too large.");
  if (endpoint.search) throw new Error("Remote MCP target cannot contain a query string.");
  return Object.freeze({
    endpoint: endpoint.href,
    name: value.startsWith("https://") ? hostname : value,
  });
}
