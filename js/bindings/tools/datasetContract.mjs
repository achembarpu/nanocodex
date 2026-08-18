export const DATASET_DESCRIPTION = `Inspect public Parquet, uncompressed JSONL, or Hugging Face datasets in the
browser. Open a URL source or {kind:"huggingface",dataset:"owner/name",config?,split?}; open returns
schema and an immediate JSONL preview. Query its dataset_id with columns, filters, offset, and limit,
then close it. Parquet uses HTTP ranges; JSONL scans sequentially. Never infer absence when complete
is false. Handles assume immutable source URLs; close and reopen to refresh changed data.`;

export const MAX_QUERY_LIMIT = 100;
export const MAX_QUERY_BYTES = 128 * 1024 * 1024;
export const MAX_QUERY_OFFSET = 10_000;

const sourceSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["url", "huggingface"] },
    url: { type: "string" },
    format: { type: "string", enum: ["parquet", "jsonl"] },
    dataset: { type: "string" },
    config: { type: "string" },
    split: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: false,
};

export const datasetParameters = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["open", "query", "close"] },
    source: sourceSchema,
    dataset_id: { type: "string" },
    columns: { type: "array", maxItems: 64, items: { type: "string" } },
    filters: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          column: { type: "string" },
          op: { type: "string", enum: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"] },
          value: {},
        },
        required: ["column", "op", "value"],
        additionalProperties: false,
      },
    },
    offset: { type: "integer", minimum: 0, maximum: MAX_QUERY_OFFSET },
    limit: { type: "integer", minimum: 1, maximum: MAX_QUERY_LIMIT },
    max_bytes: { type: "integer", minimum: 1024, maximum: MAX_QUERY_BYTES },
  },
  required: ["operation"],
  additionalProperties: false,
};
