import init, { Nanocodex } from "../pkg-web/nanocodex.js";

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
import { createBrowserHost } from "./host.mjs";
import { resolveTools } from "../runtime/tool-configuration.mjs";
import { resolve as resolveTransport } from "./Transport.mjs";

let initialized;

export function prewarm(options = {}) {
  return initialized ||= (options.module === undefined
    ? init()
    : init({ module_or_path: options.module })).catch((error) => {
      initialized = undefined;
      throw error;
    });
}

export function create(options = {}) {
  const {
    transport,
    module,
    model,
    thinking,
    reasoningMode,
    fastMode,
    instructions,
    sessionId,
    workspace,
    resume,
    filesystem,
    filesystemTools,
    tools,
    toolMode,
    mcp,
    executionEnvironment,
    codeEvaluator,
  } = options;
  const {
    apiKey,
    hostAuth,
    subscription,
    mpp,
    websocketUrl,
    apiBaseUrl,
    websocketWarmup,
    WebSocketImpl,
    createWebSocket,
  } = resolveTransport(transport);
  const { tools: hostTools, subagents: subagentConfig } = resolveTools(tools);
  if (filesystem && workspace !== undefined && workspace !== filesystem.root) {
    throw new TypeError("workspace must match filesystem.root when both are provided");
  }
  const events = createEventChannel();
  const tempoMcp = mpp?.[Symbol.for("nanocodex.tempo.mcp")];
  let hostDefinitionId;
  const host = createBrowserHost({
    WebSocketImpl,
    createWebSocket,
    hostAuth: hostAuth === true
      || (apiKey === undefined && mpp === undefined && subscription === undefined),
    mpp,
    onEvent: events.emit,
    filesystem,
    filesystemTools,
    tools: hostTools,
    toolMode,
    mcp: mcp === false
      ? undefined
      : tempoMcp ? { ...tempoMcp, ...mcp } : mcp,
    codeEvaluator,
    onDispose: () => releaseDefinitionHost(hostDefinitionId),
  });
  hostDefinitionId = registerDefinitionHost(host);
  activateHost(host);
  const runtime = defineRuntime({
    key: "browser-wasm",
    name: "Nanocodex Browser WASM",
    type: "browser",
    async create(config) {
      try {
        activateHost(host);
        await host.ready();
        await prewarm({ module });
        activateHost(host);
        const configJson = JSON.stringify(toWasmConfig({
          apiKey: apiKey ?? (mpp === undefined
            ? subscription === undefined ? "host-managed" : "subscription-managed"
            : "mpp-managed"),
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
    executionEnvironment,
    resume,
  });
}

function releaseHost(host) {
  void host.release().catch((error) => {
    if (typeof globalThis.reportError === "function") globalThis.reportError(error);
    else console.error(error);
  });
}
