import init, { Nanocodex } from "../pkg-web/nanocodex.js";

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
import { createBrowserHost } from "./host.mjs";

let initialized;

export function create(options = {}) {
  const {
    apiKey,
    hostAuth,
    mpp,
    websocketUrl,
    apiBaseUrl,
    module,
    model,
    thinking,
    reasoningMode,
    fastMode,
    instructions,
    sessionId,
    workspace,
    resume,
    WebSocketImpl,
    createWebSocket,
    tools,
    toolMode,
    mcp,
    codeEvaluator,
  } = options;
  if (mpp !== undefined && apiKey !== undefined) {
    throw new TypeError("apiKey and mpp are mutually exclusive");
  }
  if (hostAuth && (apiKey !== undefined || mpp !== undefined)) {
    throw new TypeError("hostAuth is mutually exclusive with apiKey and mpp");
  }
  const events = createEventChannel();
  const host = createBrowserHost({
    WebSocketImpl,
    createWebSocket,
    hostAuth: hostAuth === true || (apiKey === undefined && mpp === undefined),
    mpp,
    onEvent: events.emit,
    tools,
    toolMode,
    mcp,
    codeEvaluator,
  });
  activateHost(host);
  const runtime = defineRuntime({
    key: "browser-wasm",
    name: "Nanocodex Browser WASM",
    type: "browser",
    async create(config) {
      try {
        activateHost(host);
        await host.ready();
        initialized ||= module === undefined ? init() : init({ module_or_path: module });
        await initialized;
        activateHost(host);
        return new Nanocodex(JSON.stringify(toWasmConfig({
          apiKey: apiKey ?? (mpp === undefined ? "host-managed" : "mpp-managed"),
          websocketUrl: websocketUrl ?? (mpp === undefined
            ? undefined
            : "wss://openai.mpp.tempo.xyz/v1/responses"),
          apiBaseUrl,
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
    workspace,
    resume,
  });
}

function releaseHost(host) {
  void host.release().catch((error) => {
    if (typeof globalThis.reportError === "function") globalThis.reportError(error);
    else console.error(error);
  });
}
