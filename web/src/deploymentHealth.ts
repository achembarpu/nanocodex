export type DeploymentCredentialSource = "brokered" | null;

export type DeploymentHealth = Readonly<{
  agentConfigured: boolean;
  credentialSource: DeploymentCredentialSource;
  deploymentSha: string | undefined;
}>;

type HealthPayload = {
  agent_configured?: unknown;
  credential_source?: unknown;
  deployment_sha?: unknown;
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
      const credentialSource = payload.agent_configured === true
        && payload.credential_source === "brokered" ? "brokered" : null;
      return Object.freeze({
        agentConfigured: credentialSource !== null,
        credentialSource,
        deploymentSha: typeof payload.deployment_sha === "string"
          ? payload.deployment_sha
          : undefined,
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
