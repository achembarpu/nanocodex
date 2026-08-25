export const subagentsBrand = Symbol("nanocodex.subagents");
export const defaultSubagentMaxConcurrency = 32;

const DEFAULT_SUBAGENTS = Object.freeze({
  max_concurrency: defaultSubagentMaxConcurrency,
});

export function resolveTools(configuration) {
  if (!Array.isArray(configuration)) {
    return { tools: configuration, subagents: DEFAULT_SUBAGENTS };
  }
  const tools = {};
  let subagents = DEFAULT_SUBAGENTS;
  let configuredSubagents = false;
  for (const entry of configuration) {
    const extension = entry?.[subagentsBrand];
    if (extension) {
      if (configuredSubagents) throw new Error("Subagents.create() may only be included once");
      configuredSubagents = true;
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
  return { tools, subagents };
}
