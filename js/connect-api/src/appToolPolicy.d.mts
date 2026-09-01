export const CHROME_EXTENSION_APP_ID: "nanocodex-chrome";
export const APP_TOOL_CATALOG_RESOURCE_PREFIX: "urn:nanocodex:app-tool-catalog:sha256:";
export function isAllowedAppToolCatalogResource(resource: unknown): boolean;
export function appToolCatalogDigestFromResources(resources: readonly string[]): `0x${string}` | undefined;
export function isChromeExtensionGrantResources(
  resources: readonly string[],
  appId: string,
  origin: string,
): boolean;
