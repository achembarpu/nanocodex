import { subagentsBrand } from "./tool-configuration.mjs";

const DEFAULT_MAX_CONCURRENCY = 32;

export function create(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Subagents.create options must be an object");
  }
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new TypeError("subagents maxConcurrency must be a positive safe integer");
  }
  return Object.freeze([Object.freeze({
    [subagentsBrand]: Object.freeze({ maxConcurrency }),
  })]);
}
