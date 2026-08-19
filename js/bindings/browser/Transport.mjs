import {
  createResponsesTransport,
  nonEmpty,
  resolveResponsesTransport,
} from "../runtime/responses-transport.mjs";

export function openAi(options) {
  const apiKey = nonEmpty(options?.apiKey, "OpenAI API key");
  return createResponsesTransport({
    apiKey,
    ...connection(options),
  });
}

export function chatGpt(options) {
  if (!options?.subscription || typeof options.subscription !== "object") {
    throw new TypeError("ChatGPT transport requires a subscription handle");
  }
  return createResponsesTransport({
    subscription: options.subscription,
    ...connection(options),
  });
}

export function hostManaged(options) {
  if (typeof options?.createWebSocket !== "function") {
    throw new TypeError("host-managed transport requires createWebSocket()");
  }
  return createResponsesTransport({
    hostAuth: true,
    ...connection(options),
  });
}

export function mpp(options) {
  if (!options?.session || typeof options.session.ws !== "function") {
    throw new TypeError("MPP transport requires a session with ws(endpoint)");
  }
  return createResponsesTransport({
    mpp: options.session,
    ...connection(options),
  });
}

export { resolveResponsesTransport as resolve };

function connection(options = {}) {
  return {
    WebSocketImpl: options.WebSocketImpl,
    apiBaseUrl: options.apiBaseUrl,
    createWebSocket: options.createWebSocket,
    websocketUrl: options.websocketUrl,
    websocketWarmup: options.websocketWarmup,
  };
}
