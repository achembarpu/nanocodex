export type DeploymentCredentialSource = "managed" | "subscription" | "user" | null;
export type DeploymentModelAccessMode = "managed" | "per_user";

export type DeploymentHealth = Readonly<{
  agentConfigured: boolean;
  authMode: "api_key" | "chatgpt" | undefined;
  credentialSource: DeploymentCredentialSource;
  deploymentSha: string | undefined;
  interactiveAuth: boolean;
  modelAccessMode: DeploymentModelAccessMode;
}>;

type HealthPayload = {
  agent_configured?: unknown;
  auth_mode?: unknown;
  credential_source?: unknown;
  deployment_sha?: unknown;
  interactive_auth?: unknown;
  model_access_mode?: unknown;
};

/** One app-owned, single-flight view of the Worker health boundary. */
export function createDeploymentHealthResource(
  fetchHealth: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  let cached: DeploymentHealth | undefined;
  let epoch = 0;
  let inFlight: Promise<DeploymentHealth> | undefined;

  const request = () => {
    if (inFlight) return inFlight;
    const requestEpoch = epoch;
    const current = fetchHealth("/api/health", {
      cache: "no-store",
      credentials: "same-origin",
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Could not check the agent session (HTTP ${response.status})`);
      }
      const payload = await response.json() as HealthPayload;
      const credentialSource = payload.agent_configured === true && (
        payload.credential_source === "subscription"
        || payload.credential_source === "user"
        || payload.credential_source === "managed"
      ) ? payload.credential_source : null;
      const modelAccessMode = payload.model_access_mode === "managed"
        ? "managed"
        : "per_user";
      return Object.freeze({
        agentConfigured: credentialSource !== null,
        authMode: payload.auth_mode === "api_key" || payload.auth_mode === "chatgpt"
          ? payload.auth_mode
          : undefined,
        credentialSource,
        deploymentSha: typeof payload.deployment_sha === "string"
          ? payload.deployment_sha
          : undefined,
        interactiveAuth: modelAccessMode === "managed"
          ? false
          : payload.interactive_auth !== false,
        modelAccessMode,
      });
    });
    inFlight = current;
    void current.then(
      (health) => {
        if (inFlight === current) {
          if (epoch === requestEpoch) cached = health;
          inFlight = undefined;
        }
      },
      () => {
        if (inFlight === current) inFlight = undefined;
      },
    );
    return current;
  };

  return Object.freeze({
    read(): Promise<DeploymentHealth> {
      return cached ? Promise.resolve(cached) : request();
    },
    refresh(): Promise<DeploymentHealth> {
      return request();
    },
    invalidate(): void {
      epoch += 1;
      cached = undefined;
      inFlight = undefined;
    },
  });
}

export const deploymentHealth = createDeploymentHealthResource();
