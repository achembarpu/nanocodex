export const subagentsBrand = Symbol("nanocodex.subagents");

export function resolveTools(configuration, durable = false) {
  if (!Array.isArray(configuration)) {
    return { tools: configuration, subagents: undefined };
  }
  const tools = {};
  let subagents;
  for (const entry of configuration) {
    const extension = entry?.[subagentsBrand];
    if (extension) {
      if (subagents) throw new Error("Subagents.create() may only be included once");
      subagents = Object.freeze({ max_concurrency: extension.maxConcurrency });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || typeof entry.name !== "string" || !entry.name.trim()) {
      throw new TypeError("tool arrays require named tools or entries from Subagents.create()");
    }
    const { name, ...tool } = entry;
    if (Object.hasOwn(tools, name)) throw new Error(`tool is already configured: ${name}`);
    tools[name] = tool;
  }
  if (durable && subagents) {
    throw new TypeError(
      "Subagents.create() cannot be combined with durability because child agents are runtime-owned and cannot be reconstructed after recovery",
    );
  }
  return { tools, subagents };
}
