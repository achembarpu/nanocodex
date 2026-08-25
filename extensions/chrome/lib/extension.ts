import type { NamedTool, ToolContext } from "nanocodex/host";
import { validateRecipe, type SiteRecipe } from "./recipe.ts";

export interface TabClaim {
  browser_instance_id: string;
  window_id: number;
  tab_id: number;
  document_id: string;
  origin: string;
  url: string;
  group_id?: number;
  observed_at_ms: number;
}

export type CleanupInput =
  | { action: "inspect" }
  | { action: "preview"; document_revision: string; recipe: SiteRecipe }
  | { action: "revert_preview"; preview_id: string };

export interface PageLease {
  lease_id: string;
  tab: TabClaim;
}

export interface PreviewInfo {
  origin: string;
  permission: string;
  recipe: SiteRecipe;
}

export type PageInterrupted = {
  type: "page.interrupted";
  lease_id: string;
  reason: string;
};

export const CLEANUP_INSTRUCTIONS = `You customize the user's currently selected web page.

Use the cleanup tool to inspect the page before proposing changes. Then call cleanup with action
"preview" and a small declarative recipe. The recipe may contain CSS and selectors to hide, but
never scripts, remote resources, invented selectors, or destructive actions. Prefer focused,
reversible changes that directly satisfy the request. A preview is not permanent: tell the user
what changed and that they can keep or revert it in the panel.`;

export const CLEANUP_PARAMETERS = {
  oneOf: [
    {
      type: "object",
      properties: { action: { const: "inspect" } },
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
} as const;

export function createCleanupTool(
  dispatch: (input: CleanupInput, context: ToolContext) => unknown | Promise<unknown>,
): NamedTool {
  return {
    name: "cleanup",
    description: "Inspect the selected page and preview or revert one declarative CSS cleanup recipe.",
    parameters: CLEANUP_PARAMETERS,
    handler(input, context) {
      return dispatch(validateCleanupInput(input), context);
    },
  };
}

export function validateCleanupInput(value: unknown): CleanupInput {
  const record = asRecord(value, "cleanup input");
  switch (record.action) {
    case "inspect":
      requireOnlyKeys(record, ["action"]);
      return { action: "inspect" };
    case "preview": {
      requireOnlyKeys(record, ["action", "document_revision", "recipe"]);
      return {
        action: "preview",
        document_revision: requiredString(record, "document_revision"),
        recipe: validateRecipe(record.recipe),
      };
    }
    case "revert_preview":
      requireOnlyKeys(record, ["action", "preview_id"]);
      return {
        action: "revert_preview",
        preview_id: requiredString(record, "preview_id"),
      };
    default:
      throw new Error(`Unsupported cleanup action: ${String(record.action)}`);
  }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== "string" || !record[key]) throw new Error(`${key} must be a non-empty string`);
  return record[key];
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const expected = new Set(allowed);
  const extra = Object.keys(record).find((key) => !expected.has(key));
  if (extra) throw new Error(`cleanup input contains unsupported field: ${extra}`);
}
