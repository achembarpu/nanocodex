import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { nanocodexTools } from "./tools.mjs";
import { chatGptSubscription } from "./chatgpt-subscription.mjs";
import { defaultCodexAuthFile, readCodexSubscription } from "./codex-auth-file.mjs";
import { startChatGptWorkerEgress } from "./chatgpt-egress.mjs";
import { startLocalOAuthRelay } from "./oauth-relay-server.mjs";

const buildScript = fileURLToPath(new URL("./scripts/build-js-package.sh", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageManifest = fileURLToPath(new URL("./package.json", import.meta.url));
const sourcePackageManifest = fileURLToPath(
  new URL("../../js/nanocodex-vite/package.json", import.meta.url),
);
const browserPackage = new URL(import.meta.resolve("nanocodex/browser"));
const generatedPackage = [
  new URL("../pkg-web/nanocodex.js", browserPackage),
  new URL(import.meta.resolve("nanocodex/wasm")),
];
let packageBuild;

export function createNanocodexVitePlugin(options, integration) {
  const tools = nanocodexTools();
  const chatGpt = options.chatGpt ?? {};
  const direct = integration.target === "vite" && chatGpt !== false
    ? chatGptSubscription(chatGpt)
    : undefined;
  const buildJsPackage = integration.buildJsPackage ?? ensureJsPackage;
  const startOAuthRelay = integration.startOAuthRelay ?? startLocalOAuthRelay;
  let buildPromise;
  let workerAuth;
  let egress;
  let oauthRelay;
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

  const cleanupOAuthRelay = async () => {
    await oauthRelay?.close();
    oauthRelay = undefined;
  };

  return {
    name: "nanocodex",
    enforce: "pre",
    resolveId: tools.resolveId,
    async config(config, environment) {
      await (buildPromise ??= buildJsPackage());
      if (options.oauthRelay === true && environment.command === "serve") {
        oauthRelay ??= await startOAuthRelay();
      } else {
        await cleanupOAuthRelay();
      }
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
        await Promise.all([cleanup(), cleanupOAuthRelay()]);
        throw new Error(
          `Nanocodex local ChatGPT setup failed: ${errorMessage(error)}. Run \`codex login\` and retry.`,
        );
      }
      return { worker: { plugins: nestedWorker } };
    },
    async configureServer(vite) {
      vite.httpServer?.once("close", () => {
        void Promise.all([cleanup(), cleanupOAuthRelay()]);
      });
      if (integration.target === "vite") {
        await direct?.configureServer(vite);
        return;
      }
      if (!workerAuth) return;
      vite.config.logger.info(
        `[nanocodex] local ChatGPT subscription ready through the application Worker (expires ${new Date(workerAuth.expiresAt).toISOString()})`,
      );
    },
    async closeBundle() {
      await Promise.all([cleanup(), cleanupOAuthRelay()]);
    },
  };
}

async function ensureJsPackage() {
  return packageBuild ??= (async () => {
    if (process.env.CI && await generatedPackageIsPresent()) return;
    if (!await isSourceCheckout()) {
      await Promise.all(generatedPackage.map((artifact) => access(artifact, constants.R_OK)));
      return;
    }
    await access(buildScript, constants.X_OK);
    await new Promise((resolve, reject) => {
      const child = spawn(buildScript, [], { cwd: repositoryRoot, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(
          `Nanocodex WASM generation failed${signal ? ` (${signal})` : ` with exit code ${code}`}`,
        ));
      });
    });
  })();
}

async function generatedPackageIsPresent() {
  try {
    await Promise.all(generatedPackage.map((artifact) => access(artifact, constants.R_OK)));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function isSourceCheckout() {
  try {
    const [loaded, source] = await Promise.all([
      realpath(packageManifest),
      realpath(sourcePackageManifest),
    ]);
    return loaded === source;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
