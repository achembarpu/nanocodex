import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { nanocodexTools } from "./tools.mjs";
import { chatGptSubscription } from "./chatgpt-subscription.mjs";
import { defaultCodexAuthFile, readCodexSubscription } from "./codex-auth-file.mjs";
import { startChatGptWorkerEgress } from "./chatgpt-egress.mjs";
import { startLocalOAuthRelay } from "./oauth-relay-server.mjs";

const buildScript = fileURLToPath(new URL("./scripts/build-js-package.sh", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const rustBuildFiles = new Set([
  resolve(repositoryRoot, "Cargo.lock"),
  resolve(repositoryRoot, "Cargo.toml"),
  resolve(repositoryRoot, ".cargo/config.toml"),
  resolve(repositoryRoot, "js/nanocodex/Cargo.toml"),
]);
const rustBuildDirectories = [
  resolve(repositoryRoot, "crates"),
  resolve(repositoryRoot, "js/nanocodex/src"),
];
const rustBuildWatchRoots = [...rustBuildFiles, ...rustBuildDirectories];
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
  const credentialBrokerWorker = integration.target === "cloudflare"
    && typeof chatGpt.credentialBrokerWorker === "string"
    ? chatGpt.credentialBrokerWorker
    : undefined;
  const direct = integration.target === "vite" && chatGpt !== false
    ? chatGptSubscription(chatGpt)
    : undefined;
  const buildJsPackage = integration.buildJsPackage ?? ensureJsPackage;
  const loadOAuthBindings = integration.loadOAuthBindings ?? localOAuthBindings;
  const startOAuthRelay = integration.startOAuthRelay ?? startLocalOAuthRelay;
  const rebuildJsPackage = integration.rebuildJsPackage ?? runJsPackageBuild;
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
    const active = oauthRelay;
    oauthRelay = undefined;
    await active?.close();
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
      ) {
        if (integration.target === "cloudflare") await cleanup();
        integration.setDevBindings?.(undefined);
        return { worker: { plugins: nestedWorker } };
      }

      await cleanup();
      cleanupPromise = undefined;
      let oauthBindings = {};
      if (options.oauthRelay === true && credentialBrokerWorker) {
        try {
          oauthBindings = await loadOAuthBindings();
        } catch (error) {
          await cleanupOAuthRelay();
          throw new Error(`Nanocodex local OAuth setup failed: ${errorMessage(error)}.`);
        }
      }
      if (chatGpt === false) {
        integration.setDevBindings(Object.freeze(oauthBindings));
        return { worker: { plugins: nestedWorker } };
      }
      try {
        const configuredAuthFile = chatGpt.authFile === undefined
          ? defaultCodexAuthFile()
          : chatGpt.authFile;
        const authFile = configuredAuthFile instanceof URL
          ? fileURLToPath(configuredAuthFile)
          : configuredAuthFile;
        workerAuth = await readCodexSubscription(authFile);
        egress = await startChatGptWorkerEgress();
        if (credentialBrokerWorker) {
          integration.setDevBindings(Object.freeze({
            ...oauthBindings,
            ALLOW_INSECURE_LOOPBACK_RELAY: "true",
            CODEX_RELAY_URL: egress.relayUrl,
            LOCAL_CHATGPT_BOOTSTRAP: JSON.stringify({
              access_token: workerAuth.accessToken,
              account_id: workerAuth.accountId,
              expires_at: workerAuth.expiresAt,
              fedramp: workerAuth.fedramp,
            }),
          }));
        } else {
          integration.setDevBindings(Object.freeze({
            ...oauthBindings,
            ENVIRONMENT: "development",
            NANOCODEX_DEV_CHATGPT_ACCESS_TOKEN: workerAuth.accessToken,
            NANOCODEX_DEV_CHATGPT_ACCOUNT_ID: workerAuth.accountId,
            NANOCODEX_DEV_CHATGPT_FEDRAMP: String(workerAuth.fedramp),
            NANOCODEX_DEV_CHATGPT_EXPIRES_AT: String(workerAuth.expiresAt),
            NANOCODEX_DEV_CHATGPT_EGRESS_URL: egress.url,
            NANOCODEX_DEV_CHATGPT_SESSION_ID: randomBytes(32).toString("base64url"),
          }));
        }
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
      if (await isSourceCheckout()) {
        watchRustBuildInputs(vite, rebuildJsPackage);
      }
      if (integration.target === "vite") {
        await direct?.configureServer(vite);
        return;
      }
      if (!workerAuth) return;
      vite.config.logger.info(
        `[nanocodex] local ChatGPT subscription ready through ${credentialBrokerWorker ?? "the application Worker"} (expires ${new Date(workerAuth.expiresAt).toISOString()})`,
      );
    },
    async closeBundle() {
      await Promise.all([cleanup(), cleanupOAuthRelay()]);
    },
  };
}

async function localOAuthBindings() {
  const environment = { ...await mainCheckoutEnvironment(), ...process.env };
  return {
    ...oauthCredentialPair(environment, {
      label: "GitHub",
      ids: ["NANOCODEX_GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_ID", "GH_CLIENT_ID"],
      secrets: ["NANOCODEX_GITHUB_OAUTH_CLIENT_SECRET", "GITHUB_OAUTH_CLIENT_SECRET", "GH_CLIENT_SECRETS"],
      targetId: "GITHUB_OAUTH_CLIENT_ID",
      targetSecret: "GITHUB_OAUTH_CLIENT_SECRET",
    }),
    ...oauthCredentialPair(environment, {
      label: "Google",
      ids: ["NANOCODEX_GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_CLIENT_ID"],
      secrets: ["NANOCODEX_GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"],
      targetId: "GOOGLE_OAUTH_CLIENT_ID",
      targetSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
    }),
    ...oauthCredentialPair(environment, {
      label: "X",
      ids: ["NANOCODEX_X_OAUTH_CLIENT_ID", "X_OAUTH_CLIENT_ID", "X_CLIENT_ID"],
      secrets: ["NANOCODEX_X_OAUTH_CLIENT_SECRET", "X_OAUTH_CLIENT_SECRET", "X_CLIENT_SECRET"],
      targetId: "X_OAUTH_CLIENT_ID",
      targetSecret: "X_OAUTH_CLIENT_SECRET",
    }),
  };
}

async function mainCheckoutEnvironment() {
  try {
    const metadataPath = resolve(repositoryRoot, ".git");
    const metadata = await stat(metadataPath);
    let environmentPath = resolve(repositoryRoot, ".env");
    if (metadata.isFile()) {
      const pointer = (await readFile(metadataPath, "utf8")).trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match) throw new Error(`${metadataPath} does not identify a Git directory`);
      const gitDirectory = resolve(dirname(metadataPath), match[1]);
      const commonDirectory = resolve(
        gitDirectory,
        (await readFile(resolve(gitDirectory, "commondir"), "utf8")).trim(),
      );
      environmentPath = resolve(dirname(commonDirectory), ".env");
    }
    return parseEnv(await readFile(environmentPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function oauthCredentialPair(environment, names) {
  const id = firstEnvironmentValue(environment, names.ids);
  const secret = firstEnvironmentValue(environment, names.secrets);
  if (Boolean(id) !== Boolean(secret)) {
    throw new Error(`local ${names.label} OAuth client ID and secret must be configured together`);
  }
  return id && secret
    ? { [names.targetId]: id, [names.targetSecret]: secret }
    : {};
}

function firstEnvironmentValue(environment, names) {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function ensureJsPackage() {
  return packageBuild ??= (async () => {
    if (process.env.CI && await generatedPackageIsPresent()) return;
    if (!await isSourceCheckout()) {
      await Promise.all(generatedPackage.map((artifact) => access(artifact, constants.R_OK)));
      return;
    }
    await runJsPackageBuild();
  })();
}

async function runJsPackageBuild() {
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
}

function watchRustBuildInputs(vite, rebuild) {
  vite.watcher.add(rustBuildWatchRoots);
  let debounce;
  let queued = false;
  let running;

  const run = () => {
    queued = true;
    running ??= (async () => {
      while (queued) {
        queued = false;
        vite.config.logger.info("[nanocodex] Rust/WASM input changed; rebuilding bindings...");
        await rebuild();
        vite.ws.send({ type: "full-reload" });
        vite.config.logger.info("[nanocodex] Rust/WASM bindings rebuilt");
      }
    })().catch((error) => {
      vite.config.logger.error(`[nanocodex] Rust/WASM rebuild failed: ${errorMessage(error)}`);
    }).finally(() => {
      running = undefined;
      if (queued) run();
    });
  };
  const changed = (path) => {
    if (!isRustBuildInput(path)) return;
    clearTimeout(debounce);
    debounce = setTimeout(run, 75);
  };
  const close = () => {
    clearTimeout(debounce);
    for (const event of ["add", "change", "unlink"]) vite.watcher.off(event, changed);
  };
  for (const event of ["add", "change", "unlink"]) vite.watcher.on(event, changed);
  vite.httpServer?.once("close", close);
}

function isRustBuildInput(path) {
  if (rustBuildFiles.has(path)) return true;
  return rustBuildDirectories.some((directory) => {
    const nested = relative(directory, path);
    return nested !== "" && !nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested);
  });
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
