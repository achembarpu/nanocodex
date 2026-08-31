import type { HostedToolCatalogEntry } from "./hosted-tools-protocol";

export const CHROME_CLEANUP_APP_TOOL_POLICY = "nanocodex-chrome-cleanup-v1";

export type ConnectAppToolPolicy = typeof CHROME_CLEANUP_APP_TOOL_POLICY;

type ConnectHostedToolGrant = Readonly<{
  grantId: string;
  mcpIds: readonly string[];
  appToolPolicy?: ConnectAppToolPolicy;
}>;

const CHROME_CLEANUP_PARAMETERS = Object.freeze({
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "list_tabs" },
        cursor: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "inspect" },
        tab_ref: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "preview" },
        document_revision: { type: "string" },
        recipe: {
          type: "object",
          properties: {
            schema_version: { const: 1 },
            name: { type: "string", minLength: 1, maxLength: 80 },
            css: { type: "string", maxLength: 32768 },
            hide_selectors: {
              type: "array",
              maxItems: 64,
              items: { type: "string", minLength: 1, maxLength: 512 },
            },
          },
          required: ["name", "css", "hide_selectors"],
          additionalProperties: false,
        },
      },
      required: ["action", "document_revision", "recipe"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "revert_preview" },
        preview_id: { type: "string" },
      },
      required: ["action", "preview_id"],
      additionalProperties: false,
    },
  ],
});

const CHROME_CLEANUP_DESCRIPTION =
  "List open web tabs, inspect one exact tab, and preview or revert one declarative CSS cleanup recipe.";

export function isConnectAppToolPolicy(value: unknown): value is ConnectAppToolPolicy {
  return value === CHROME_CLEANUP_APP_TOOL_POLICY;
}

export function appToolCatalogEntryAllowed(
  policy: ConnectAppToolPolicy | undefined,
  entry: HostedToolCatalogEntry,
): boolean {
  return policy === CHROME_CLEANUP_APP_TOOL_POLICY
    && entry.provider === "javascript"
    && entry.remote_name === "cleanup"
    && entry.definition.type === "function"
    && entry.definition.name === "cleanup"
    && entry.definition.description === CHROME_CLEANUP_DESCRIPTION
    && entry.definition.strict === false
    && jsonEqual(entry.definition.parameters, CHROME_CLEANUP_PARAMETERS)
    && entry.definition.output_schema === undefined
    && entry.parallel_safe === false
    && entry.summary === undefined
    && entry.timeout_ms === 120_000;
}

export function hostedToolCatalogEntryAllowed(
  grant: ConnectHostedToolGrant | undefined,
  hostConnectGrantId: string | undefined,
  entry: HostedToolCatalogEntry,
): boolean {
  if (grant === undefined) return hostConnectGrantId === undefined;
  if (hostConnectGrantId !== grant.grantId) return false;
  const match = /^mcp:([A-Za-z0-9_-]{43})$/.exec(entry.provider);
  return match === null
    ? appToolCatalogEntryAllowed(grant.appToolPolicy, entry)
    : grant.mcpIds.includes(match[1]!);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonEqual(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
