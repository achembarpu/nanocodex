import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import MiniSearch from "minisearch";

import { toolResult } from "./code-runtime.mjs";

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 32;
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60_000;
const SEARCH_DESCRIPTION_PREFIX = "# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.";

export async function createMcpRuntime(configuration, options = {}) {
  const servers = normalizeServers(configuration);
  const entries = [];
  const failures = Object.create(null);
  const ownedClients = [];

  await Promise.all(servers.map(async (server) => {
    try {
      const connection = await connectServer(server, options);
      if (connection.owned) ownedClients.push(connection.client);
      const tools = await listAllTools(connection.client);
      for (const tool of tools) {
        if (!includesTool(server, tool.name)) continue;
        entries.push(createEntry(server, connection.client, tool));
      }
    } catch (error) {
      failures[server.name] = errorMessage(error);
    }
  }));

  entries.sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
  const byName = new Map();
  for (const entry of entries) {
    const existing = byName.get(entry.canonicalName);
    if (existing) {
      throw new Error(
        `MCP tool name collision: ${existing.server.name}/${existing.remoteName} and ${entry.server.name}/${entry.remoteName} both normalize to ${entry.canonicalName}`,
      );
    }
    byName.set(entry.canonicalName, entry);
  }
  const search = createSearchIndex(entries);
  const toolSearch = {
    name: "tool_search",
    handler: ({ query, limit }) => searchTools(query, limit),
  };

  function searchTools(query, limit = DEFAULT_SEARCH_LIMIT) {
    if (typeof query !== "string" || !query.trim()) {
      throw new TypeError("tool_search query must not be empty");
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError("tool_search limit must be a positive integer");
    }
    const selected = search
      .search(query, { combineWith: "OR", prefix: true })
      .slice(0, Math.min(limit, MAX_SEARCH_LIMIT))
      .map(({ id }) => byName.get(id))
      .filter(Boolean);
    const result = {
      tools: selected.map((entry) => ({
        name: entry.canonicalName,
        server: entry.server.name,
        tool: entry.remoteName,
        description: entry.description,
        input_schema: entry.inputSchema,
      })),
      pending_servers: 0,
      failed_servers: { ...failures },
    };
    return toolResult(result, loadableNamespaces(selected));
  }

  return Object.freeze({
    definitions() {
      return [toolSearchDefinition(servers), ...entries.map((entry) => entry.definition)];
    },
    resolve(name) {
      if (name === "tool_search") return toolSearch;
      const entry = byName.get(name);
      if (!entry) return undefined;
      return {
        name,
        handler: (input, context) => callRemoteTool(entry, input, context),
      };
    },
    async close() {
      await Promise.allSettled(ownedClients.map((client) => client.close()));
    },
  });
}

async function listAllTools(client) {
  const tools = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const listed = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...listed.tools);
    if (!listed.nextCursor) return tools;
    if (seen.has(listed.nextCursor)) throw new Error("MCP tools/list returned a repeated cursor");
    seen.add(listed.nextCursor);
    cursor = listed.nextCursor;
  }
  throw new Error("MCP tools/list exceeded 100 pages");
}

async function connectServer(server, options) {
  const client = server.client ?? new Client({
    name: options.clientName ?? "nanocodex-js",
    version: options.clientVersion ?? "0.0.0",
  });
  if (server.payment) {
    const { McpClient } = await import("mppx/mcp/client");
    const { context: _context, ...payment } = server.payment;
    McpClient.wrap(client, payment);
  }
  if (server.client) return { client, owned: false };
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    ...(server.fetch ? { fetch: server.fetch } : {}),
    ...(server.headers ? { requestInit: { headers: server.headers } } : {}),
  });
  try {
    await client.connect(transport);
    return { client, owned: true };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function normalizeServers(configuration) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new TypeError("mcp must be an object keyed by server name");
  }
  const servers = Object.entries(configuration).map(([name, value]) => {
    if (!name.trim()) throw new TypeError("MCP server name must not be empty");
    const server = typeof value === "string" || value instanceof URL ? { url: value } : value;
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      throw new TypeError(`MCP server ${name} must be a URL or configuration object`);
    }
    if (!server.client && !server.url) {
      throw new TypeError(`MCP server ${name} requires url or client`);
    }
    if (server.payment && (!Array.isArray(server.payment.methods) || !server.payment.methods.length)) {
      throw new TypeError(`MCP server ${name} payment requires at least one method`);
    }
    if (server.enabledTools && !isStringArray(server.enabledTools)) {
      throw new TypeError(`MCP server ${name} enabledTools must be an array of strings`);
    }
    if (server.disabledTools && !isStringArray(server.disabledTools)) {
      throw new TypeError(`MCP server ${name} disabledTools must be an array of strings`);
    }
    if (server.timeoutMs !== undefined
      && (!Number.isFinite(server.timeoutMs) || server.timeoutMs <= 0)) {
      throw new TypeError(`MCP server ${name} timeoutMs must be a positive number`);
    }
    return {
      ...server,
      name,
      url: server.url?.toString(),
      timeoutMs: server.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    };
  });
  if (!servers.length) throw new TypeError("mcp requires at least one server");
  return servers;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function createEntry(server, client, tool) {
  const remoteName = tool.name;
  const canonicalName = `${canonicalNamespace(server.name)}${normalizeName(remoteName)}`;
  const inputSchema = normalizeInputSchema(tool.inputSchema);
  const description = tool.description ?? "";
  return {
    canonicalName,
    client,
    definition: Object.freeze({
      type: "function",
      name: canonicalName,
      description,
      strict: false,
      defer_loading: true,
      parameters: inputSchema,
    }),
    description,
    inputSchema,
    remoteName,
    searchText: [
      canonicalName,
      server.name,
      remoteName,
      tool.title ?? "",
      description,
      ...Object.keys(inputSchema.properties ?? {}),
    ].join(" "),
    server,
  };
}

function createSearchIndex(entries) {
  const index = new MiniSearch({
    fields: ["searchText"],
    idField: "id",
    tokenize: tokenizeSearchText,
  });
  index.addAll(entries.map((entry) => ({ id: entry.canonicalName, searchText: entry.searchText })));
  return index;
}

async function callRemoteTool(entry, input) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), entry.server.timeoutMs);
  try {
    const options = {
      signal: controller.signal,
      ...(entry.server.payment?.context !== undefined
        ? { context: entry.server.payment.context }
        : {}),
    };
    return await entry.client.callTool(
      { name: entry.remoteName, arguments: input ?? {} },
      undefined,
      options,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `MCP tool ${entry.server.name}/${entry.remoteName} exceeded ${entry.server.timeoutMs} milliseconds`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function toolSearchDefinition(servers) {
  const sources = servers.map((server) => {
    const description = server.description?.trim();
    return `- ${server.name}${description ? `: ${description}` : ""}`;
  }).join("\n");
  return Object.freeze({
    type: "tool_search",
    execution: "client",
    description: `${SEARCH_DESCRIPTION_PREFIX}\n\nYou have access to tools from the following sources:\n${sources}\nSome tools are omitted from the initial request. Use \`tool_search\` for MCP discovery before calling them from Code Mode.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for deferred tools." },
        limit: { type: "number", description: "Maximum number of tools to return. Defaults to 8." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  });
}

function loadableNamespaces(entries) {
  const namespaces = new Map();
  for (const entry of entries) {
    const name = canonicalNamespace(entry.server.name);
    let namespace = namespaces.get(name);
    if (!namespace) {
      namespace = {
        type: "namespace",
        name,
        description: entry.server.description?.trim() || `Tools in the ${name} namespace.`,
        tools: [],
      };
      namespaces.set(name, namespace);
    }
    namespace.tools.push({
      type: "function",
      name: normalizeName(entry.remoteName),
      description: entry.description,
      strict: false,
      defer_loading: true,
      parameters: entry.inputSchema,
    });
  }
  return [...namespaces.values()];
}

function normalizeInputSchema(schema) {
  const input = schema && typeof schema === "object" && !Array.isArray(schema)
    ? JSON.parse(JSON.stringify(schema))
    : { type: "object" };
  input.properties ??= {};
  return input;
}

function includesTool(server, name) {
  return (!server.enabledTools || server.enabledTools.includes(name))
    && !server.disabledTools?.includes(name);
}

function canonicalNamespace(serverName) {
  return `mcp__${normalizeName(serverName)}__`;
}

function normalizeName(name) {
  return [...name].map((character) => /[A-Za-z0-9_-]/.test(character) ? character : "_").join("");
}

function tokenizeSearchText(text) {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
