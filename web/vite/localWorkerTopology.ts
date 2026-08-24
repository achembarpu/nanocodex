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
const LOCAL_EGRESS_WORKER = "nanocodex-egress";
const DEVELOPMENT_SIGNING_KEY = "nanocodex-local-room-signing-key";

/**
 * Cloudflare requires Workers that share external Durable Objects or upgraded
 * Service Binding responses to run in one local multi-Worker session. Keep the
 * provider credential broker and managed Worker in the same local session so
 * account, credential, agent, and room routes use the production topology.
 */
export function localManagedAuxiliaryWorkers(
  environment: NodeJS.ProcessEnv = process.env,
): AuxiliaryWorker[] {
  const signingKey = environment.NANOCODEX_LOCAL_ADMIN_TOKEN?.trim()
    || DEVELOPMENT_SIGNING_KEY;
  const idleTimeout = environment.NANOCODEX_LOCAL_AGENT_IDLE_TIMEOUT_MS?.trim() || "1000";
  const relayUrl = environment.NANOCODEX_LOCAL_CODEX_RELAY_URL?.trim();
  const connectorVars = localConnectorVars(environment);
  if (!/^[1-9][0-9]*$/.test(idleTimeout)) {
    throw new Error("local managed Worker idle timeout must be a positive integer");
  }

  return [
    {
      configPath: "../services/egress/wrangler.broker.jsonc",
      devOnly: true,
      config: (configuration) => ({
        name: LOCAL_EGRESS_WORKER,
        vars: {
          ...configuration.vars,
          ENVIRONMENT: "development",
          ALLOW_LOCAL_CREDENTIAL_CLAIM: "true",
          ...(relayUrl
            ? {
                ALLOW_INSECURE_LOOPBACK_RELAY: "true",
                CODEX_RELAY_URL: relayUrl,
              }
            : {}),
          ...(environment.NANOCODEX_LOCAL_CHATGPT_BOOTSTRAP
            ? { LOCAL_CHATGPT_BOOTSTRAP: environment.NANOCODEX_LOCAL_CHATGPT_BOOTSTRAP }
            : {}),
          ...connectorVars,
        },
      }),
    },
    {
      configPath: "../services/managed/wrangler.jsonc",
      devOnly: true,
      config: (configuration) => ({
        // CLOUDFLARE_ENV applies to every Worker in the Vite session. Pin the
        // auxiliary name so Service Bindings resolve the production names.
        name: LOCAL_MANAGED_WORKER,
        vars: {
          ...configuration.vars,
          AGENT_IDLE_TIMEOUT_MS: idleTimeout,
          NANOCODEX_ADMIN_TOKEN: signingKey,
        },
      }),
    },
  ];
}

function localConnectorVars(environment: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...credentialPair(environment, {
      id: "NANOCODEX_LOCAL_GITHUB_OAUTH_CLIENT_ID",
      secret: "NANOCODEX_LOCAL_GITHUB_OAUTH_CLIENT_SECRET",
      targetId: "GITHUB_OAUTH_CLIENT_ID",
      targetSecret: "GITHUB_OAUTH_CLIENT_SECRET",
      label: "GitHub",
    }),
    ...credentialPair(environment, {
      id: "NANOCODEX_LOCAL_GOOGLE_OAUTH_CLIENT_ID",
      secret: "NANOCODEX_LOCAL_GOOGLE_OAUTH_CLIENT_SECRET",
      targetId: "GOOGLE_OAUTH_CLIENT_ID",
      targetSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
      label: "Google",
    }),
    ...credentialPair(environment, {
      id: "NANOCODEX_LOCAL_X_OAUTH_CLIENT_ID",
      secret: "NANOCODEX_LOCAL_X_OAUTH_CLIENT_SECRET",
      targetId: "X_OAUTH_CLIENT_ID",
      targetSecret: "X_OAUTH_CLIENT_SECRET",
      label: "X",
    }),
  };
}

function credentialPair(
  environment: NodeJS.ProcessEnv,
  names: { id: string; secret: string; targetId: string; targetSecret: string; label: string },
): Record<string, string> {
  const id = environment[names.id]?.trim();
  const secret = environment[names.secret]?.trim();
  if (Boolean(id) !== Boolean(secret)) {
    throw new Error(`local ${names.label} OAuth client ID and secret must be configured together`);
  }
  return id && secret ? { [names.targetId]: id, [names.targetSecret]: secret } : {};
}
