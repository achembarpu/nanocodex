export * as Actions from "./actions/index.mjs";

export function subscriptionRevision(value) {
  const revision = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(revision)) {
    throw new TypeError("subscription revision must be an unsigned decimal string");
  }
  return revision;
}

export function createMemoryChatGptSubscriptionStore(id, initial) {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError("subscription ID must be a non-empty string");
  }
  let stored = Object.freeze({
    revision: subscriptionRevision(initial?.revision ?? 0n),
    ...(initial?.payload === undefined ? {} : { payload: initial.payload }),
  });
  const select = (selected) => {
    if (selected !== id) throw new Error(`unknown ChatGPT subscription: ${selected}`);
  };
  return Object.freeze({
    id,
    load(selected) {
      select(selected);
      return stored;
    },
    compareAndSwap(selected, request) {
      select(selected);
      if (request.expectedRevision !== stored.revision) {
        return { status: "conflict", actualRevision: stored.revision };
      }
      const revision = subscriptionRevision(BigInt(stored.revision) + 1n);
      stored = Object.freeze({ revision, payload: request.payload });
      return { status: "committed", revision };
    },
    snapshot() {
      return stored;
    },
  });
}

export { createQuickJsEvaluator } from "./runtime/quickjs-evaluator.mjs";
export {
  createTempoProvider,
  createTempoProviderFromAccounts,
  DEFAULT_MERCATOR_MCP_URL,
} from "./runtime/tempo-provider.mjs";
