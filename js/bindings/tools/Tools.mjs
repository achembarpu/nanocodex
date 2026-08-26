import { resolveTools } from "../runtime/tool-configuration.mjs";
import { tools as workspaceTools } from "../runtime/workspace.mjs";
import {
  providerSource,
  ToolRouter,
  toolMapSource,
  toolRouterBrand,
  toolRouterRuntime,
  toolRuntimeLifecycle,
} from "../runtime/tool-router.mjs";
import { createAttachment } from "./attachment.mjs";

/**
 * Builds one language-neutral JavaScript-owned tool runtime.
 * Empty custom tools, no workspace, and no MCP are the defaults.
 */
export async function createTools(options = {}) {
  validateOptions(options);
  const router = new ToolRouter();
  const resolved = resolveTools(
    options.tools === undefined ? {} : options.tools,
    { defaultSubagents: false },
  );
  if (resolved.subagents) throw new TypeError("createTools does not accept agent-relative extensions");
  const custom = resolved.tools;
  if (Object.keys(custom).length) {
    router.addSource(toolMapSource("custom", custom, { kind: "cloud" }));
  }
  if (options.workspace !== undefined) {
    router.addSource(toolMapSource(
      "workspace",
      workspaceTools(options.workspace, options.workspaceOptions),
      { kind: "cloud" },
    ));
  }
  let mcp;
  const attachments = new Set();
  if (options.mcp !== undefined && options.mcp !== false) {
    const { createMcpRuntime } = await import("../runtime/mcp-runtime.mjs");
    mcp = await createMcpRuntime(options.mcp, options.mcpOptions);
    router.addSource(providerSource("mcp", mcp, { kind: "mcp" }));
  }
  let closed = false;
  let claimed = false;
  let owner;
  const lifecycle = Object.freeze({
    available() {
      if (closed) throw new Error("Tools runtime is closed");
      if (claimed) throw new Error("Tools runtime already belongs to an Agent host");
    },
    claim() {
      this.available();
      claimed = true;
    },
    close() { return owner.close(); },
  });
  owner = {
    [toolRouterBrand]: true,
    [toolRouterRuntime]: router,
    [toolRuntimeLifecycle]: lifecycle,
    attach(target, attachmentOptions = {}) {
      if (closed) throw new Error("Tools runtime is closed");
      const attachment = createAttachment(owner, target, attachmentOptions);
      attachments.add(attachment);
      return attachment;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...attachments].map((attachment) => attachment.close()));
      attachments.clear();
      router.reset();
      await mcp?.close();
    },
  };
  return Object.freeze(owner);
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("createTools options must be an object");
  }
  const allowed = new Set(["tools", "workspace", "workspaceOptions", "mcp", "mcpOptions"]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new TypeError(`unsupported createTools option: ${name}`);
  }
  if (options.workspace === undefined && options.workspaceOptions !== undefined) {
    throw new TypeError("workspaceOptions requires workspace");
  }
  if ((options.mcp === undefined || options.mcp === false) && options.mcpOptions !== undefined) {
    throw new TypeError("mcpOptions requires mcp");
  }
}

