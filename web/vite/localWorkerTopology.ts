type WorkerConfiguration = {
  name?: string;
  vars?: Record<string, unknown>;
};

type AuxiliaryWorker = {
  configPath: string;
  devOnly: true;
  config: (configuration: WorkerConfiguration) => WorkerConfiguration;
};

const LOCAL_MANAGED_WORKER = "nanocodex-durable-agent";

/**
 * Cloudflare requires Workers that share external Durable Objects or upgraded
 * Service Binding responses to run in one local multi-Worker session. Keep the
 * provider credential broker outside this session: only the managed Worker is
 * an auxiliary Worker, and its environment contains placeholders/policy but no
 * OpenAI or ChatGPT credential.
 */
export function localManagedAuxiliaryWorkers(
  environment: NodeJS.ProcessEnv = process.env,
): AuxiliaryWorker[] {
  if (environment.NANOCODEX_LOCAL_MODEL_ACCESS !== "managed") return [];

  const authMode = exact(environment, "NANOCODEX_LOCAL_MODEL_AUTH_MODE");
  if (authMode !== "api_key" && authMode !== "chatgpt") {
    throw new Error("local managed Worker auth mode must be api_key or chatgpt");
  }
  const adminToken = exact(environment, "NANOCODEX_LOCAL_ADMIN_TOKEN");
  const roomAllocatorToken = exact(environment, "NANOCODEX_LOCAL_ROOM_ALLOCATOR_TOKEN");
  if (adminToken === roomAllocatorToken) {
    throw new Error("local managed Worker credentials must be distinct");
  }
  const idleTimeout = environment.NANOCODEX_LOCAL_AGENT_IDLE_TIMEOUT_MS?.trim() || "1000";
  if (!/^[1-9][0-9]*$/.test(idleTimeout)) {
    throw new Error("local managed Worker idle timeout must be a positive integer");
  }

  return [{
    configPath: "../examples/cloudflare-workers/wrangler.jsonc",
    devOnly: true,
    config: (configuration) => ({
      // CLOUDFLARE_ENV applies to every Worker in the Vite session. Pin the
      // auxiliary name so the website and broker Service Bindings resolve the
      // same local service names as production.
      name: LOCAL_MANAGED_WORKER,
      vars: {
        ...configuration.vars,
        AGENT_IDLE_TIMEOUT_MS: idleTimeout,
        NANOCODEX_ADMIN_TOKEN: adminToken,
        NANOCODEX_AUTH_MODE: authMode,
        NANOCODEX_ROOM_ALLOCATOR_TOKEN: roomAllocatorToken,
      },
    }),
  }];
}

export function localRoomAllocatorToken(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (environment.NANOCODEX_LOCAL_MODEL_ACCESS !== "managed") return undefined;
  return exact(environment, "NANOCODEX_LOCAL_ROOM_ALLOCATOR_TOKEN");
}

function exact(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value || value !== environment[name]) {
    throw new Error(`${name} is required and must not contain surrounding whitespace`);
  }
  return value;
}
