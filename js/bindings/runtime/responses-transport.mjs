const RESPONSES_TRANSPORT = Symbol("nanocodex.responsesTransport");

export function createResponsesTransport(setup) {
  return Object.freeze({
    [RESPONSES_TRANSPORT]: () => setup,
  });
}

export function resolveResponsesTransport(transport) {
  const resolve = transport?.[RESPONSES_TRANSPORT];
  if (typeof resolve !== "function") {
    throw new TypeError("Agent.create requires a Responses transport");
  }
  return resolve();
}

export function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
