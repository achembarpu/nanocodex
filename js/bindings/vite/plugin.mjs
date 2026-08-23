import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { nanocodexTools } from "../tools/vite.mjs";
import { chatGptSubscription } from "./chatgpt-subscription.mjs";
import { defaultCodexAuthFile, readCodexSubscription } from "./codex-auth-file.mjs";
import { startChatGptWorkerEgress } from "./chatgpt-egress.mjs";

export function createNanocodexVitePlugin(options, integration) {
  const tools = nanocodexTools();
  const chatGpt = options.chatGpt ?? {};
  const direct = integration.target === "vite" && chatGpt !== false
    ? chatGptSubscription(chatGpt)
    : undefined;
  let workerAuth;
  let egress;
  let cleanupPromise;

  const cleanup = () => cleanupPromise ??= (async () => {
    try {
      await egress?.close();
    } finally {
      egress = undefined;
      workerAuth = undefined;
      integration.setDevBindings?.(undefined);
    }
  })();

  return {
    name: "nanocodex",
    enforce: "pre",
    resolveId: tools.resolveId,
    async config(config, environment) {
      const nestedWorker = workerPlugins(config.worker?.plugins);
      if (
        integration.target !== "cloudflare"
        || environment.command !== "serve"
        || chatGpt === false
      ) {
        if (integration.target === "cloudflare") await cleanup();
        integration.setDevBindings?.(undefined);
        return { worker: { plugins: nestedWorker } };
      }

      await cleanup();
      cleanupPromise = undefined;
      try {
        const configuredAuthFile = chatGpt.authFile === undefined
          ? defaultCodexAuthFile()
          : chatGpt.authFile;
        const authFile = configuredAuthFile instanceof URL
          ? fileURLToPath(configuredAuthFile)
          : configuredAuthFile;
        workerAuth = await readCodexSubscription(authFile);
        egress = await startChatGptWorkerEgress();
        integration.setDevBindings(Object.freeze({
          ENVIRONMENT: "development",
          NANOCODEX_DEV_CHATGPT_ACCESS_TOKEN: workerAuth.accessToken,
          NANOCODEX_DEV_CHATGPT_ACCOUNT_ID: workerAuth.accountId,
          NANOCODEX_DEV_CHATGPT_FEDRAMP: String(workerAuth.fedramp),
          NANOCODEX_DEV_CHATGPT_EXPIRES_AT: String(workerAuth.expiresAt),
          NANOCODEX_DEV_CHATGPT_EGRESS_URL: egress.url,
          NANOCODEX_DEV_CHATGPT_SESSION_ID: randomBytes(32).toString("base64url"),
        }));
      } catch (error) {
        await cleanup();
        throw new Error(
          `Nanocodex local ChatGPT setup failed: ${errorMessage(error)}. Run \`codex login\` and retry.`,
        );
      }
      return { worker: { plugins: nestedWorker } };
    },
    async configureServer(vite) {
      if (integration.target === "vite") {
        await direct?.configureServer(vite);
        return;
      }
      if (!workerAuth) return;
      vite.config.logger.info(
        `[nanocodex] local ChatGPT subscription ready through the application Worker (expires ${new Date(workerAuth.expiresAt).toISOString()})`,
      );
      vite.httpServer?.once("close", () => { void cleanup(); });
    },
    async closeBundle() {
      await cleanup();
    },
  };
}

function workerPlugins(existing) {
  return () => {
    const configured = typeof existing === "function" ? existing() : [];
    const plugins = (configured ?? []).flat(Infinity).filter(Boolean);
    return plugins.some((plugin) => plugin?.name === "nanocodex-tools")
      ? plugins
      : [nanocodexTools(), ...plugins];
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
