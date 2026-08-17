import init, { Nanocodex } from "../pkg-web/nanocodex.js";

import { agentActions } from "../actions/index.mjs";
import {
  activateHost,
  bindHostSession,
  createAgentClient,
  createEventChannel,
  defineRuntime,
  loadDurabilityRuntime,
  loadSubscriptionRuntime,
  reportError,
  releaseHostSession,
  toWasmConfig,
} from "../internal.mjs";
import { createBrowserHost } from "./host.mjs";

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
    apiKey,
    hostAuth,
    subscription,
    mpp,
    websocketUrl,
    apiBaseUrl,
    module,
    model,
    thinking,
    reasoningMode,
    fastMode,
    websocketWarmup,
    instructions,
    sessionId,
    workspace,
    resume,
    durability,
    durabilityId,
    WebSocketImpl,
    createWebSocket,
    filesystem,
    filesystemTools,
    tools,
    toolMode,
    mcp,
    executionEnvironment,
    codeEvaluator,
  } = options;
  if (mpp !== undefined && apiKey !== undefined) {
    throw new TypeError("apiKey and mpp are mutually exclusive");
  }
  if (hostAuth && (apiKey !== undefined || mpp !== undefined)) {
    throw new TypeError("hostAuth is mutually exclusive with apiKey and mpp");
  }
  if (subscription !== undefined && (hostAuth || apiKey !== undefined || mpp !== undefined)) {
    throw new TypeError("subscription is mutually exclusive with hostAuth, apiKey, and mpp");
  }
  if (filesystem && workspace !== undefined && workspace !== filesystem.root) {
    throw new TypeError("workspace must match filesystem.root when both are provided");
  }
  const events = createEventChannel();
  const tempoMcp = mpp?.[Symbol.for("nanocodex.tempo.mcp")];
  const host = createBrowserHost({
    WebSocketImpl,
    createWebSocket,
    hostAuth: hostAuth === true
      || (apiKey === undefined && mpp === undefined && subscription === undefined),
    mpp,
    onEvent: events.emit,
    filesystem,
    filesystemTools,
    tools,
    toolMode,
    mcp: mcp === false
      ? undefined
      : tempoMcp ? { ...tempoMcp, ...mcp } : mcp,
    codeEvaluator,
  });
  let durabilityOwner;
  activateHost(host);
  const runtime = defineRuntime({
    key: "browser-wasm",
    name: "Nanocodex Browser WASM",
    type: "browser",
    async create(config) {
      try {
        if (durability !== undefined || durabilityId !== undefined) {
          durabilityOwner = (await loadDurabilityRuntime()).own(
            host,
            durability,
            durabilityId,
          );
        }
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
          ...config,
        }));
        return subscription === undefined
          ? Nanocodex.create(configJson)
          : Nanocodex.createWithChatGpt(
              configJson,
              (await loadSubscriptionRuntime()).rawSubscription(subscription),
            );
      } catch (error) {
        durabilityOwner?.abandon();
        await host.dispose();
        throw error;
      }
    },
    subscribe: events.subscribe,
    adopt(raw) {
      host.retain();
      try {
        durabilityOwner?.retain();
        bindHostSession(host, raw.sessionId);
      } catch (error) {
        durabilityOwner?.release();
        releaseHost(host);
        throw error;
      }
    },
    release(raw) {
      releaseHostSession(host, raw.sessionId);
      durabilityOwner?.release();
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
    durabilityId,
  });
}

function releaseHost(host) {
  void host.release().catch(reportError);
}
