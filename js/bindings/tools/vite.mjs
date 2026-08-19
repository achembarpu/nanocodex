import { fileURLToPath } from "node:url";

const browserSsh = fileURLToPath(
  new URL("./browser/devTunnelsSshBrowser.mjs", import.meta.url),
);
const unsupportedNodeRsa = fileURLToPath(
  new URL("./browser/unsupportedNodeRsa.mjs", import.meta.url),
);

/**
 * Keeps unreachable Node-only SSH fallbacks out of browser and Worker bundles.
 * Add this before framework plugins so nested Worker builds inherit it.
 */
export function nanocodexTools() {
  return {
    name: "nanocodex-tools",
    enforce: "pre",
    resolveId(source) {
      if (source === "@microsoft/dev-tunnels-ssh") return browserSsh;
      if (source === "node-rsa") return unsupportedNodeRsa;
      return null;
    },
  };
}
