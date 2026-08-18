import { createRequire } from "node:module";
import initWeb, { Nanocodex as WebNanocodex } from "../pkg-web/nanocodex.js";

import { agentActions } from "../actions/index.mjs";
import {
  activateHost,
  bindHostSession,
  createAgentClient,
  createEventChannel,
  defineRuntime,
  releaseHostSession,
  toWasmConfig,
} from "../internal.mjs";
import { createNodeHost } from "./host.mjs";

let initializedWeb;
let NodeNanocodex;

export function create(options = {}) {
  const {
    model,
    thinking,
    reasoningMode,
    fastMode,
    websocketWarmup,
    instructions,
    sessionId,
    workspace,
    resume,
    apiKey,
    mpp,
    websocketUrl,
    apiBaseUrl,
    module,
    filesystem,
    tools,
    toolMode,
    mcp,
    codeEvaluator,
  } = options;
  const events = createEventChannel();
  if (mpp !== undefined && apiKey !== undefined) {
    throw new TypeError("apiKey and mpp are mutually exclusive");
  }
  if (filesystem && workspace !== undefined && workspace !== filesystem.root) {
    throw new TypeError("workspace must match filesystem.root when both are provided");
  }
  const tempoMcp = mpp?.[Symbol.for("nanocodex.tempo.mcp")];
  const host = createNodeHost({
    mpp,
    mcpServers: mcp === false
      ? undefined
      : tempoMcp ? { ...tempoMcp, ...mcp } : mcp,
    onEvent: events.emit,
    filesystem,
    tools,
    toolMode,
    workspace: workspace ?? filesystem?.root ?? resume?.workspace,
    codeEvaluator,
  });
  activateHost(host);
  const runtime = defineRuntime({
    key: "node-wasm",
    name: "Nanocodex Node WASM",
    type: "node",
    async create(config) {
      try {
        activateHost(host);
        await host.ready();
        const Nanocodex = module === undefined
          ? loadNodeNanocodex()
          : await loadWebNanocodex(module);
        activateHost(host);
        return new Nanocodex(JSON.stringify(toWasmConfig({
          apiKey: apiKey ?? (mpp === undefined ? undefined : "mpp-managed"),
          websocketUrl: websocketUrl ?? (mpp === undefined
            ? undefined
            : "wss://openai.mpp.tempo.xyz/v1/responses"),
          apiBaseUrl,
          websocketWarmup,
          ...config,
        })));
      } catch (error) {
        await host.dispose();
        throw error;
      }
    },
    subscribe: events.subscribe,
    adopt(raw) {
      host.retain();
      try {
        bindHostSession(host, raw.sessionId);
      } catch (error) {
        releaseHost(host);
        throw error;
      }
    },
    release(raw) {
      releaseHostSession(host, raw.sessionId);
      releaseHost(host);
    },
    decorate: (agent) => agent.extend(agentActions()),
  });
  return createAgentClient(runtime, {
    model,
    thinking,
    reasoningMode,
    fastMode,
    instructions,
    sessionId,
    workspace: workspace ?? filesystem?.root,
    resume,
  });
}

function releaseHost(host) {
  void host.release().catch((error) => {
    if (typeof globalThis.reportError === "function") globalThis.reportError(error);
    else console.error(error);
  });
}

function loadNodeNanocodex() {
  const require = createRequire(import.meta.url);
  NodeNanocodex ||= require("../pkg-node/nanocodex.js").Nanocodex;
  return NodeNanocodex;
}

async function loadWebNanocodex(module) {
  initializedWeb ||= initWeb({ module_or_path: module });
  await initializedWeb;
  return WebNanocodex;
}
