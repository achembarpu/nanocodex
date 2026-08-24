import { namedTool } from "../namedTool.mjs";

const CONNECTOR_IDS = ["github", "gmail", "gdrive"];
const CONNECTOR_INFO_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["ready", "requires_login", "unavailable"],
    },
    authenticated: {
      type: "array",
      items: { type: "string", enum: CONNECTOR_IDS },
    },
    accounts: {
      type: "object",
      properties: Object.fromEntries(CONNECTOR_IDS.map((id) => [id, { type: "string" }])),
      additionalProperties: false,
    },
  },
  required: ["status", "authenticated", "accounts"],
  additionalProperties: false,
});

export function browserConnectorEgressTool(options) {
  return namedTool("connectorEgress", {
    description: "Report which connected account APIs and display identities are available through transparent gh/curl egress. Never returns credentials.",
    parameters: { type: "object", additionalProperties: false },
    outputSchema: CONNECTOR_INFO_SCHEMA,
    handler: (_input, context) => browserConnectorEgress(options, context?.signal),
  });
}

export function browserRuntimeInfoTool(options) {
  return namedTool("runtimeInfo", {
    description: "Return information about the browser agent runtime and connected-account egress.",
    parameters: { type: "object", additionalProperties: false },
    async handler(_input, context) {
      return {
        runtime: "browser-worker",
        shell: "nanocodex-just-bash",
        shell_network: "connector-http-gateway",
        sandbox: "browser",
        workspace: "/workspace",
        custom_commands: ["gh"],
        connector_egress: await browserConnectorEgress(options, context?.signal),
      };
    },
  });
}

export async function browserConnectorEgress(options, signal) {
  if (typeof options?.fetch !== "function") throw new TypeError("browser connector status requires fetch");
  const endpoint = new URL("/v1/connectors", options.origin);
  try {
    const response = await options.fetch(endpoint, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (response.status === 401) {
      await response.body?.cancel();
      return emptyInfo("requires_login");
    }
    if (!response.ok) {
      await response.body?.cancel();
      return emptyInfo("unavailable");
    }
    const value = await response.json();
    if (!record(value) || !record(value.connectors)) return emptyInfo("unavailable");
    const accounts = {};
    const authenticated = CONNECTOR_IDS.filter((id) => {
      const connector = value.connectors[id];
      if (!record(connector) || connector.connected !== true) return false;
      if (typeof connector.label === "string" && connector.label.trim()) {
        accounts[id] = connector.label.trim();
      }
      return true;
    });
    return { status: "ready", authenticated, accounts };
  } catch (error) {
    if (signal?.aborted) throw error;
    return emptyInfo("unavailable");
  }
}

function emptyInfo(status) {
  return { status, authenticated: [], accounts: {} };
}

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
