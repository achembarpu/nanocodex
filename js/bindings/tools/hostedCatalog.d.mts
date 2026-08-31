import type { NamedTool } from "../host/index.mjs";

export type HostedToolCatalogEntry = Readonly<{
  provider: string;
  remote_name: string;
  definition: Readonly<Record<string, unknown>>;
  parallel_safe: boolean;
  summary?: string | undefined;
  timeout_ms: number;
}>;

export function hostedAppToolCatalog(
  tools: readonly NamedTool[] | Readonly<Record<string, unknown>>,
  provider?: string,
): readonly HostedToolCatalogEntry[];

export function hostedCatalog(catalog: readonly HostedToolCatalogEntry[]): readonly HostedToolCatalogEntry[];
export function hostedToolCatalogDigest(catalog: readonly HostedToolCatalogEntry[]): Promise<`0x${string}`>;
