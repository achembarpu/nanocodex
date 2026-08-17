import { createRequire } from "node:module";
import initWeb, { Nanocodex as WebNanocodex } from "../pkg-web/nanocodex.js";

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
    durability,
    durabilityId,
    apiKey,
    subscription,
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
  if (subscription !== undefined && (apiKey !== undefined || mpp !== undefined)) {
    throw new TypeError("subscription is mutually exclusive with apiKey and mpp");
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
  let durabilityOwner;
  activateHost(host);
  const runtime = defineRuntime({
    key: "node-wasm",
    name: "Nanocodex Node WASM",
    type: "node",
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
    resume,
    durabilityId,
  });
}

function releaseHost(host) {
  void host.release().catch(reportError);
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
