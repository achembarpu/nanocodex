import {
  defaultSubagentMaxConcurrency,
  subagentsBrand,
} from "./tool-configuration.mjs";

export function create(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Subagents.create options must be an object");
  }
  const maxConcurrency = options.maxConcurrency ?? defaultSubagentMaxConcurrency;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new TypeError("subagents maxConcurrency must be a positive safe integer");
  }
  return Object.freeze([Object.freeze({
    [subagentsBrand]: Object.freeze({ maxConcurrency }),
  })]);
}
