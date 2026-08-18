import { createRequire } from "node:module";
import initWeb, { Nanocodex as WebNanocodex } from "../pkg-web/nanocodex.js";

import { agentActions } from "../actions/index.mjs";
import {
  activateHost,
  bindHostSession,
  createAgentClient,
  createEventChannel,
  defineRuntime,
  loadSubscriptionRuntime,
  registerDefinitionHost,
  releaseDefinitionHost,
  releaseHostSession,
  toWasmConfig,
} from "../internal.mjs";
import { createNodeHost } from "./host.mjs";
import { resolveTools } from "../runtime/tool-configuration.mjs";
import { resolve as resolveTransport } from "./Transport.mjs";

let initializedWeb;
let NodeNanocodex;

export function create(options = {}) {
  const {
    model,
    thinking,
    reasoningMode,
    fastMode,
    instructions,
    sessionId,
    workspace,
    resume,
    transport,
    module,
    filesystem,
    tools,
    toolMode,
    mcp,
    codeEvaluator,
  } = options;
  const {
    apiKey,
    subscription,
    mpp,
    websocketUrl,
    apiBaseUrl,
    websocketWarmup,
  } = resolveTransport(transport);
  const { tools: hostTools, subagents: subagentConfig } = resolveTools(tools);
  const events = createEventChannel();
  if (filesystem && workspace !== undefined && workspace !== filesystem.root) {
    throw new TypeError("workspace must match filesystem.root when both are provided");
  }
  const tempoMcp = mpp?.[Symbol.for("nanocodex.tempo.mcp")];
  let hostDefinitionId;
  const host = createNodeHost({
    mpp,
    mcpServers: mcp === false
      ? undefined
      : tempoMcp ? { ...tempoMcp, ...mcp } : mcp,
    onEvent: events.emit,
    filesystem,
    tools: hostTools,
    toolMode,
    workspace: workspace ?? filesystem?.root ?? resume?.workspace,
    codeEvaluator,
    onDispose: () => releaseDefinitionHost(hostDefinitionId),
  });
  hostDefinitionId = registerDefinitionHost(host);
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
        const configJson = JSON.stringify(toWasmConfig({
          apiKey: apiKey ?? (subscription === undefined
            ? mpp === undefined ? undefined : "mpp-managed"
            : "subscription-managed"),
          websocketUrl: websocketUrl ?? (mpp === undefined
            ? undefined
            : "wss://openai.mpp.tempo.xyz/v1/responses"),
          apiBaseUrl,
          websocketWarmup,
          subagents: subagentConfig,
          hostDefinitionId,
          ...config,
        }));
        return subscription === undefined
          ? new Nanocodex(configJson)
          : Nanocodex.createWithChatGpt(
              configJson,
              (await loadSubscriptionRuntime()).rawSubscription(subscription),
            );
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
      host.releaseSession(raw.sessionId);
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
