import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MANAGED_MCP_CATALOG,
  createDefaultManagedTools,
  defaultManagedMcpServers,
} from "../src/default-mcp";

describe("durable managed default MCP catalog", () => {
  it("matches the canonical five public MCP servers", () => {
    expect(DEFAULT_MANAGED_MCP_CATALOG).toEqual({
      openaiDeveloperDocs: {
        url: "https://developers.openai.com/mcp",
        description: "Search OpenAI developer documentation.",
        parallelTools: ["fetch_openai_doc", "search_openai_docs"],
      },
      tempo: {
        url: "https://mcp.tempo.xyz",
        description: "Tempo network and protocol tools.",
        parallelTools: ["code", "search"],
      },
      cloudflare: {
        url: "https://docs.mcp.cloudflare.com/mcp",
        description: "Search Cloudflare developer documentation.",
        parallelTools: ["search_cloudflare_documentation"],
      },
      viem: {
        url: "https://viem.sh/api/mcp",
        description: "Search Viem developer documentation.",
        parallelTools: ["list_pages", "read_page", "search_docs", "search_source"],
      },
      vocs: {
        url: "https://vocs.dev/api/mcp",
        description: "Search Vocs developer documentation.",
        parallelTools: ["list_pages", "read_page", "search_docs", "search_source"],
      },
    });
  });

  it("places every default on the managed server fetch boundary", () => {
    const fetcher = vi.fn<typeof fetch>();
    const configured = defaultManagedMcpServers(fetcher);

    expect(Object.keys(configured)).toEqual([
      "openaiDeveloperDocs",
      "tempo",
      "cloudflare",
      "viem",
      "vocs",
    ]);
    for (const server of Object.values(configured)) {
      expect(typeof server).toBe("object");
      expect((server as { fetch?: typeof fetch }).fetch).toBe(fetcher);
    }
  });

  it("prepares cloud and MCP tools behind one server-owned search catalog", async () => {
    const mcp = Object.fromEntries(
      Object.keys(DEFAULT_MANAGED_MCP_CATALOG).map((server) => [
        server,
        {
          client: {
            async listTools() {
              return {
                tools: [{
                  name: "search",
                  description: `Search ${server}`,
                  inputSchema: { type: "object", additionalProperties: false },
                }],
              };
            },
            async callTool() {
              return { content: [] };
            },
          },
        },
      ]),
    );
    const tools = await createDefaultManagedTools([{
      name: "accountInfo",
      description: "Account information.",
      parameters: { type: "object", additionalProperties: false },
      handler: () => ({ ready: true }),
    }], mcp);
    const socket = new CatalogSocket();
    const connector = tools.attach({
      endpoint: "wss://managed.test/tools",
      transport: { connect: async () => socket },
    });

    try {
      const connecting = connector.connect();
      await waitFor(() => socket.frames.some((frame) => frame.type === "catalog"));
      const catalog = socket.frames.find((frame) => frame.type === "catalog");
      expect(catalog?.tools?.map((entry) => entry.definition.name).sort()).toEqual([
        "accountInfo",
        "mcp__cloudflare__search",
        "mcp__openaiDeveloperDocs__search",
        "mcp__tempo__search",
        "mcp__viem__search",
        "mcp__vocs__search",
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource",
      ].sort());
      socket.receive({ type: "ready" });
      const client = await connecting;
      const closing = client.close();
      await waitFor(() => socket.frames.some((frame) => frame.type === "drain"));
      socket.receive({ type: "draining" });
      await closing;
    } finally {
      await tools.close();
    }
  });
});

type AttachmentFrame = {
  type: string;
  tools?: { definition: { name: string } }[];
};

class CatalogSocket {
  readyState = 1;
  frames: AttachmentFrame[] = [];
  listeners = new Map<string, ((event: { data?: string; code?: number; reason?: string }) => void)[]>();

  send(value: string) {
    this.frames.push(JSON.parse(value) as AttachmentFrame);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  addEventListener(
    type: string,
    listener: (event: { data?: string; code?: number; reason?: string }) => void,
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  receive(frame: AttachmentFrame) {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  emit(type: string, event: { data?: string; code?: number; reason?: string }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}
