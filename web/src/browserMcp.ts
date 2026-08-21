export const DEFAULT_BROWSER_MCP_SERVERS = Object.freeze({
  openaiDeveloperDocs: {
    path: "/api/mcp/openai-developer-docs",
    description: "Search OpenAI developer documentation.",
    enabledTools: ["search_openai_docs"],
  },
  cloudflare: {
    path: "/api/mcp/cloudflare",
    description: "Search Cloudflare developer documentation.",
    enabledTools: ["search_cloudflare_documentation"],
  },
  viem: {
    path: "/api/mcp/viem",
    description: "Search Viem developer documentation.",
    enabledTools: ["search_docs"],
  },
  vocs: {
    path: "/api/mcp/vocs",
    description: "Search Vocs developer documentation.",
    enabledTools: ["search_docs"],
  },
});

export function browserMcpConfiguration(origin: string) {
  return Object.fromEntries(
    Object.entries(DEFAULT_BROWSER_MCP_SERVERS).map(([name, server]) => [
      name,
      {
        description: server.description,
        enabledTools: [...server.enabledTools],
        headers: { "x-nanocodex-request": "1" },
        startupTimeoutMs: 30_000,
        timeoutMs: 300_000,
        url: new URL(server.path, origin).href,
      },
    ]),
  );
}
