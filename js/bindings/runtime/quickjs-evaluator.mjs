const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_STACK_LIMIT_BYTES = 512 * 1024;
const DEFAULT_INTERRUPT_CYCLES = 1_000_000;

/**
 * Builds a Code Mode evaluator for runtimes that reject eval/new Function.
 * Pass an asyncified QuickJS WASM module from quickjs-emscripten-core.
 */
export function createQuickJsEvaluator(quickJs, options = {}) {
  if (!quickJs || typeof quickJs.newContext !== "function") {
    throw new TypeError("quickJs must be an asyncified QuickJS WASM module");
  }
  let queue = Promise.resolve();

  return (source, environment) => {
    const evaluation = queue.then(() => evaluate(quickJs, source, environment, options));
    queue = evaluation.catch(() => {});
    return evaluation;
  };
}

async function evaluate(quickJs, source, environment, options) {
  const vm = quickJs.newContext();
  const runtime = vm.runtime;
  runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(options.stackLimitBytes ?? DEFAULT_STACK_LIMIT_BYTES);
  let interruptCycles = 0;
  const maxInterruptCycles = options.maxInterruptCycles ?? DEFAULT_INTERRUPT_CYCLES;
  runtime.setInterruptHandler(() => ++interruptCycles > maxInterruptCycles);

  try {
    exposeAsync(vm, "__nanocodex_call_tool", async (nameHandle, inputHandle) => {
      try {
        const name = vm.getString(nameHandle);
        const tool = environment.tools[name];
        if (typeof tool !== "function") throw new Error(`unknown application tool: ${name}`);
        const input = JSON.parse(vm.getString(inputHandle));
        const value = await tool(input);
        return vm.newString(JSON.stringify({ ok: true, value }));
      } catch (error) {
        return vm.newString(JSON.stringify({ ok: false, error: errorMessage(error) }));
      }
    });
    expose(vm, "__nanocodex_emit", (kindHandle, payloadHandle) => {
      const kind = vm.getString(kindHandle);
      const payload = JSON.parse(vm.getString(payloadHandle));
      if (kind === "text") environment.text(payload);
      else if (kind === "image") environment.image(payload.value, payload.detail);
      else if (kind === "generatedImage") environment.generatedImage(payload);
      else throw new Error(`unknown Code Mode output kind: ${kind}`);
    });
    expose(vm, "__nanocodex_store", (keyHandle, valueHandle) => {
      const key = vm.getString(keyHandle);
      const envelope = JSON.parse(vm.getString(valueHandle));
      environment.store(key, envelope.value);
    });
    expose(vm, "__nanocodex_load", (keyHandle) => {
      const value = environment.load(vm.getString(keyHandle));
      return vm.newString(JSON.stringify({ value }));
    });
    expose(vm, "__nanocodex_log", (levelHandle, valuesHandle) => {
      const level = vm.getString(levelHandle);
      const values = JSON.parse(vm.getString(valuesHandle));
      const logger = typeof environment.console?.[level] === "function"
        ? environment.console[level]
        : environment.console?.log;
      logger?.(...values);
    });

    const setup = guestSource(
      source,
      Object.keys(environment.tools),
      environment.toolDefinitions,
    );
    const started = await vm.evalCodeAsync(setup, "nanocodex-code-mode.js");
    const promise = unwrap(vm, started);
    try {
      const settling = vm.resolvePromise(promise);
      runtime.executePendingJobs().unwrap();
      const settled = await settling;
      unwrap(vm, settled).dispose();
    } finally {
      promise.dispose();
    }
  } finally {
    vm.dispose();
  }
}

function expose(vm, name, handler) {
  vm.newFunction(name, handler).consume((handle) => vm.setProp(vm.global, name, handle));
}

function exposeAsync(vm, name, handler) {
  if (typeof vm.newAsyncifiedFunction !== "function") {
    throw new TypeError("QuickJS module must use an asyncify variant");
  }
  vm.newAsyncifiedFunction(name, handler).consume((handle) => vm.setProp(vm.global, name, handle));
}

function unwrap(vm, result) {
  if (result.error) {
    const dumped = vm.dump(result.error);
    result.error.dispose();
    throw new Error(formatQuickJsError(dumped));
  }
  return result.value;
}

function formatQuickJsError(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if (typeof error.stack === "string") {
      return typeof error.message === "string" && !error.stack.includes(error.message)
        ? `${error.message}\n${error.stack}`
        : error.stack;
    }
    if (typeof error.message === "string") return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function guestSource(source, toolNames, toolDefinitions) {
  return `
const __nanocodex_exit = Symbol("exit");
const __nanocodex_stringify = (value) => {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value); } catch { return String(value); }
};
const __nanocodex_decode = (encoded) => {
  const result = JSON.parse(encoded);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const tools = Object.freeze(Object.fromEntries(
  ${JSON.stringify(toolNames)}.map((name) => [name, (input) =>
    __nanocodex_decode(__nanocodex_call_tool(name, JSON.stringify(input ?? null)))])
));
const ALL_TOOLS = Object.freeze(${JSON.stringify(toolDefinitions)});
const text = (value) => __nanocodex_emit("text", JSON.stringify(__nanocodex_stringify(value)));
const image = (value, detail = "auto") =>
  __nanocodex_emit("image", JSON.stringify({ value, detail }));
const generatedImage = (value) =>
  __nanocodex_emit("generatedImage", JSON.stringify(value));
const store = (key, value) => {
  if (typeof key !== "string") throw new TypeError("store key must be a string");
  __nanocodex_store(key, JSON.stringify({ value }));
};
const load = (key) => JSON.parse(__nanocodex_load(key)).value;
const exit = () => { throw __nanocodex_exit; };
const require = undefined;
const console = Object.freeze(Object.fromEntries(
  ["debug", "info", "log", "warn", "error"].map((level) => [level, (...values) =>
    __nanocodex_log(level, JSON.stringify(values.map(__nanocodex_stringify)))])
));
(async () => {
  try {
${source}
  } catch (error) {
    if (error !== __nanocodex_exit) throw error;
  }
})()
`;
}

function errorMessage(error) {
  if (error && (error.stack || error.message)) return error.stack || error.message;
  return String(error);
}
