export function createCodeRuntime(toolConfiguration = {}, extras = {}) {
  const activeExecutions = new Set();
  const stores = new Map();
  const providers = [];
  let nextCallId = 1;
  const definitions = [];
  const configuredTools = [];
  const toolByName = new Map();

  function addTools(configuration = {}) {
    for (const [name, tool] of Object.entries(configuration)) {
      if (toolByName.has(name)) throw new Error(`tool is already configured: ${name}`);
      if (!tool || typeof tool.handler !== "function") {
        throw new TypeError(`tool ${name} requires a handler function`);
      }
      const configured = Object.freeze({ handler: tool.handler, name });
      configuredTools.push(configured);
      toolByName.set(name, configured);
      definitions.push(deepFreeze({
        type: "function",
        name,
        description: tool.description || "Application-defined tool.",
        strict: false,
        parameters: jsonSnapshot(tool.parameters || {
          type: "object",
          additionalProperties: true,
        }, `tool ${name} parameters`),
      }));
    }
  }
  addTools(toolConfiguration);

  function currentDefinitions() {
    return [
      ...definitions,
      ...providers.flatMap((provider) => provider.definitions()),
    ];
  }

  function currentCodeDefinitions() {
    return currentDefinitions().map((definition) => definition.type === "tool_search"
      ? deepFreeze({
          type: "function",
          name: "tool_search",
          description: definition.description,
          strict: false,
          parameters: jsonSnapshot(definition.parameters, "tool_search parameters"),
        })
      : definition);
  }

  function currentTools() {
    const tools = [...configuredTools];
    for (const provider of providers) {
      for (const definition of provider.definitions()) {
        const name = definition.type === "tool_search" ? "tool_search" : definition.name;
        const tool = provider.resolve(name);
        if (tool) tools.push(tool);
      }
    }
    return tools;
  }

  function resolveTool(name) {
    const configured = toolByName.get(name);
    if (configured) return configured;
    for (const provider of providers) {
      const tool = provider.resolve(name);
      if (tool) return tool;
    }
  }

  async function executeTool(name, encodedInput, sessionId = "default", callId = "tool") {
    const tool = resolveTool(name);
    if (!tool) return encodeToolOutput(`unknown application tool: ${name}`, false, null);
    let input;
    try {
      input = JSON.parse(encodedInput);
    } catch (error) {
      return encodeToolOutput(`invalid tool input: ${errorMessage(error)}`, false, null);
    }
    const controller = new AbortController();
    const execution = { callId, controller, sessionId };
    activeExecutions.add(execution);
    try {
      const result = await tool.handler(input, {
        sessionId,
        parentCallId: "",
        callId,
        signal: controller.signal,
      });
      return encodeToolOutput(outputBody(result), true, structuredResult(result, `tool ${name} result`));
    } catch (error) {
      return encodeToolOutput(errorMessage(error), false, null);
    } finally {
      activeExecutions.delete(execution);
    }
  }

  async function executeCode(source, sessionId = "default", parentCallId = "exec") {
    const startedAt = performance.now();
    const content = [];
    const stored = stores.get(sessionId) || new Map();
    stores.set(sessionId, stored);
    const nestedCalls = [];
    const controller = new AbortController();
    const execution = { callId: parentCallId, controller, sessionId };
    activeExecutions.add(execution);
    const tools = Object.create(null);
    const availableTools = currentTools();
    const availableDefinitions = currentCodeDefinitions();
    for (const { handler, name } of availableTools) {
      tools[name] = async (input) => {
        const callId = `${parentCallId}/code-${nextCallId++}`;
        const toolStartedAt = performance.now();
        const startedAfterNs = Math.max(
          0,
          Math.round((toolStartedAt - startedAt) * 1_000_000),
        );
        const recordedInput = clone(input) ?? null;
        try {
          if (controller.signal.aborted) throw new Error("Code Mode execution was cancelled");
          const result = await handler(input, {
            sessionId,
            parentCallId,
            callId,
            signal: controller.signal,
          });
          nestedCalls.push({
            call_id: callId,
            name,
            input: recordedInput,
            output: outputBody(result),
            structured_result: structuredResult(result, `tool ${name} result`),
            success: true,
            started_after_ns: startedAfterNs,
            duration_ns: elapsedNs(toolStartedAt),
          });
          return isToolResult(result) ? result.output : result;
        } catch (error) {
          const message = errorMessage(error);
          nestedCalls.push({
            call_id: callId,
            name,
            input: recordedInput,
            output: message,
            structured_result: message,
            success: false,
            started_after_ns: startedAfterNs,
            duration_ns: elapsedNs(toolStartedAt),
          });
          throw error;
        }
      };
    }
    Object.freeze(tools);
    const EXIT = Symbol("exit");

    function text(value) {
      content.push({ type: "input_text", text: stringify(value) });
    }
    function image(value, detail = "auto") {
      if (typeof value === "string") {
        content.push({ type: "input_image", image_url: value, detail });
        return;
      }
      if (!value || typeof value !== "object" || typeof value.image_url !== "string") {
        throw new TypeError("image() requires an image URL or image item");
      }
      content.push({
        type: "input_image",
        image_url: value.image_url,
        detail: value.detail == null ? detail : value.detail,
      });
    }
    function generatedImage(result) {
      if (!result || typeof result !== "object" || typeof result.image_url !== "string") {
        throw new TypeError("generatedImage() requires an image generation result");
      }
      image(result.image_url, "high");
      if (typeof result.output_hint === "string" && result.output_hint) text(result.output_hint);
    }
    function store(key, value) {
      if (typeof key !== "string") throw new TypeError("store key must be a string");
      stored.set(key, clone(value));
    }
    function load(key) {
      return stored.has(key) ? clone(stored.get(key)) : undefined;
    }
    function exit() {
      throw EXIT;
    }

    try {
      try {
        await (extras.evaluate || evaluateNative)(source, {
          tools,
          toolDefinitions: availableDefinitions,
          text,
          image,
          generatedImage,
          store,
          load,
          exit,
          require: extras.require,
          console: extras.console || console,
        });
      } catch (error) {
        if (error !== EXIT) throw error;
      }
      return JSON.stringify({
        output: withStatus("Script completed", startedAt, content),
        success: true,
        nested_calls: nestedCalls,
      });
    } catch (error) {
      return JSON.stringify({
        output: `Script failed\nWall time ${wallTime(startedAt)} seconds\nOutput:\n${errorMessage(error)}`,
        success: false,
        nested_calls: nestedCalls,
      });
    } finally {
      activeExecutions.delete(execution);
    }
  }

  return Object.freeze({
    addTools,
    addProvider(provider) {
      if (!provider || typeof provider.definitions !== "function" || typeof provider.resolve !== "function") {
        throw new TypeError("a Code Mode tool provider requires definitions() and resolve(name)");
      }
      providers.push(provider);
    },
    executeCode,
    executeTool,
    cancel(sessionId) {
      for (const execution of activeExecutions) {
        if (sessionId === undefined || execution.sessionId === sessionId) {
          execution.controller.abort();
        }
      }
    },
    toolDefinitions: () => JSON.stringify(currentDefinitions()),
    reset() {
      for (const execution of activeExecutions) execution.controller.abort();
      stores.clear();
    },
  });
}

async function evaluateNative(source, environment) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const script = new AsyncFunction(
    "tools",
    "ALL_TOOLS",
    "text",
    "image",
    "generatedImage",
    "store",
    "load",
    "exit",
    "require",
    "console",
    source,
  );
  await script(
    environment.tools,
    environment.toolDefinitions,
    environment.text,
    environment.image,
    environment.generatedImage,
    environment.store,
    environment.load,
    environment.exit,
    environment.require,
    environment.console,
  );
}

function encodeToolOutput(output, success, structuredResult) {
  return JSON.stringify({
    output,
    success,
    structured_result: structuredResult,
    metadata: null,
    process_trace: null,
  });
}

function outputBody(value) {
  if (isToolResult(value)) return outputBody(value.output);
  if (Array.isArray(value) && value.every((item) => item?.type === "input_text" || item?.type === "input_image")) {
    return clone(value);
  }
  return stringify(value);
}

function stringify(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clone(value) {
  if (typeof globalThis.structuredClone === "function") return structuredClone(value);
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function jsonSnapshot(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable`, { cause: error });
  }
}

function structuredResult(value, label) {
  if (isToolResult(value)) return jsonSnapshot(value.structuredResult, label);
  return value === undefined ? null : jsonSnapshot(value, label);
}

const TOOL_RESULT = Symbol("nanocodex.toolResult");

export function toolResult(output, structuredResult = output) {
  return Object.freeze({ [TOOL_RESULT]: true, output, structuredResult });
}

function isToolResult(value) {
  return Boolean(value?.[TOOL_RESULT]);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function errorMessage(error) {
  if (error && (error.stack || error.message)) return error.stack || error.message;
  return String(error);
}

function elapsedNs(startedAt) {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1_000_000));
}

function wallTime(startedAt) {
  return ((performance.now() - startedAt) / 1_000).toFixed(1);
}

function withStatus(status, startedAt, content) {
  const heading = `${status}\nWall time ${wallTime(startedAt)} seconds\nOutput:\n`;
  if (!content.length) return heading;
  return [{ type: "input_text", text: heading }, ...content];
}
