import type { McpServers, NamedTool, Tools } from "nanocodex";
import { createTools } from "nanocodex/tools";

export const DEFAULT_MANAGED_MCP_CATALOG = Object.freeze({
  openaiDeveloperDocs: Object.freeze({
    url: "https://developers.openai.com/mcp",
    description: "Search OpenAI developer documentation.",
    parallelTools: Object.freeze(["fetch_openai_doc", "search_openai_docs"]),
  }),
  tempo: Object.freeze({
    url: "https://mcp.tempo.xyz",
    description: "Tempo network and protocol tools.",
    parallelTools: Object.freeze(["code", "search"]),
  }),
  cloudflare: Object.freeze({
    url: "https://docs.mcp.cloudflare.com/mcp",
    description: "Search Cloudflare developer documentation.",
    parallelTools: Object.freeze(["search_cloudflare_documentation"]),
  }),
  viem: Object.freeze({
    url: "https://viem.sh/api/mcp",
    description: "Search Viem developer documentation.",
    parallelTools: Object.freeze(["list_pages", "read_page", "search_docs", "search_source"]),
  }),
  vocs: Object.freeze({
    url: "https://vocs.dev/api/mcp",
    description: "Search Vocs developer documentation.",
    parallelTools: Object.freeze(["list_pages", "read_page", "search_docs", "search_source"]),
  }),
});

export function defaultManagedMcpServers(
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): McpServers {
  return Object.fromEntries(
    Object.entries(DEFAULT_MANAGED_MCP_CATALOG).map(([name, server]) => [
      name,
      {
        ...server,
        parallelTools: [...server.parallelTools],
        fetch: fetcher,
      },
    ]),
  );
}

/** Prepares the cloud-owned tools and public MCP catalog as one durable runtime. */
export function createDefaultManagedTools(
  tools: readonly NamedTool[],
  mcp: McpServers = defaultManagedMcpServers(),
): Promise<Tools> {
  return createTools({
    tools,
    mcp,
    mcpOptions: {
      clientName: "nanocodex-managed",
      clientVersion: "0.5.0",
    },
  });
}
