import { applyBrowserPatch, Nanocodex } from "../pkg-web/nanocodex.js";

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
  registerDefinitionHost,
  releaseDefinitionHost,
  releaseHostSession,
  toWasmConfig,
} from "../internal.mjs";
import { createBrowserHost } from "./host.mjs";
import { initializeBrowserEngine } from "./engine.mjs";
import { resolveResponsesTransport } from "../runtime/responses-transport.mjs";
import { resolveTools } from "../runtime/tool-configuration.mjs";
import {
  hostManaged as defaultHostManagedTransport,
} from "./Transport.mjs";

/** Creates the Rust/WASM Agent in the current Web API host isolate. */
export async function create(options = {}) {
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
    durability,
    durabilityId,
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
    hostManagedProtocol,
    subscription,
    mpp,
    websocketUrl,
    websocketPreconnect,
    apiBaseUrl,
    websocketWarmup,
    WebSocketImpl,
    createWebSocket,
  } = resolveResponsesTransport(transport ?? defaultHostManagedTransport());
  const { tools: hostTools, subagents: subagentConfig } = resolveTools(
    tools,
    durability !== undefined || durabilityId !== undefined,
  );
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
    hostManagedProtocol,
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
    applyPatch: applyBrowserPatch,
    websocketPreconnect,
    websocketUrl,
    onDispose: () => releaseDefinitionHost(hostDefinitionId),
  });
  let durabilityOwner;
  hostDefinitionId = registerDefinitionHost(host);
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
        await initializeBrowserEngine({ module });
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
        events.addSource(raw);
      } catch (error) {
        events.removeSource(raw);
        durabilityOwner?.release();
        releaseHost(host);
        throw error;
      }
    },
    release(raw) {
      events.removeSource(raw);
      host.releaseSession(raw.sessionId);
      releaseHostSession(host, raw.sessionId);
      durabilityOwner?.release();
      releaseHost(host);
    },
    decorate: (agent) => agent.extend(agentActions()),
  });
  const agent = await createAgentClient(runtime, {
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
  if (websocketPreconnect && websocketUrl) {
    void host.preconnect(websocketUrl, agent.sessionId).catch(reportError);
  }
  return agent;
}

function releaseHost(host) {
  void host.release().catch(reportError);
}
