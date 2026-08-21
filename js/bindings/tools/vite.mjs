import { fileURLToPath } from "node:url";

const browserSsh = fileURLToPath(
  new URL("./browser/devTunnelsSshBrowser.mjs", import.meta.url),
);
const unsupportedNodeRsa = fileURLToPath(
  new URL("./browser/unsupportedNodeRsa.mjs", import.meta.url),
);
const browserSprintf = fileURLToPath(
  new URL("./browser/browserSprintf.mjs", import.meta.url),
);
const browserZlib = fileURLToPath(
  new URL("./browser/browserZlib.mjs", import.meta.url),
);

/**
 * Keeps unreachable Node-only SSH fallbacks out of browser and Worker bundles.
 * Add this before framework plugins so nested Worker builds inherit it.
 */
export function nanocodexTools() {
  return {
    name: "nanocodex-tools",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@microsoft/dev-tunnels-ssh") return browserSsh;
      if (source === "node-rsa") return unsupportedNodeRsa;
      if (source === "node:zlib") return browserZlib;
      // Let the compatibility module's own default import reach Vite's normal
      // CommonJS transform; every external named import resolves to this ESM
      // boundary instead of relying on consumer optimizeDeps configuration.
      if (source === "sprintf-js" && importer?.split("?", 1)[0] !== browserSprintf) {
        return browserSprintf;
      }
      return null;
    },
  };
}
