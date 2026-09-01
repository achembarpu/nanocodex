import { useCallback, useEffect, useMemo, useState } from "react";
import { deploymentHealth, type DeploymentHealth } from "./deploymentHealth.ts";

declare const __NANOCODEX_DEPLOYMENT_SHA__: string;

const bundledDeploymentSha = typeof __NANOCODEX_DEPLOYMENT_SHA__ === "string"
  ? __NANOCODEX_DEPLOYMENT_SHA__
  : undefined;

export function createDeploymentRolloverGuard({
  currentDeploymentSha,
  refresh,
  reload,
}: {
  currentDeploymentSha: string | undefined;
  refresh(): Promise<DeploymentHealth>;
  reload(): void;
}): () => Promise<void> {
  let check: Promise<void> | undefined;
  let reloadBarrier: Promise<void> | undefined;
  return () => {
    if (reloadBarrier) return reloadBarrier;
    if (check) return check;
    check = (async () => {
      if (!currentDeploymentSha) {
        throw new Error("The browser bundle has no deployment generation; reload before using the local agent");
      }
      const liveDeploymentSha = (await refresh()).deploymentSha;
      if (!liveDeploymentSha) {
        throw new Error("The active deployment could not attest its generation; retry before using the local agent");
      }
      if (liveDeploymentSha === currentDeploymentSha) return;
      reloadBarrier = new Promise<void>(() => {});
      try {
        reload();
      } catch (error) {
        reloadBarrier = undefined;
        throw error;
      }
      await reloadBarrier;
    })();
    const releaseCheck = () => {
      if (!reloadBarrier) check = undefined;
    };
    void check.then(releaseCheck, releaseCheck);
    return check;
  };
}

export function useDeploymentRollover() {
  const [deploymentCurrent, setDeploymentCurrent] = useState(false);
  const generationGuard = useMemo(() => createDeploymentRolloverGuard({
    currentDeploymentSha: bundledDeploymentSha,
    refresh: () => deploymentHealth.refresh(),
    reload: () => window.location.reload(),
  }), []);
  const beforeLocalTurn = useCallback(async () => {
    await generationGuard();
    setDeploymentCurrent(true);
  }, [generationGuard]);
  useEffect(() => {
    let active = true;
    void beforeLocalTurn().then(() => {
      if (active) setDeploymentCurrent(true);
    }).catch(() => {});
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void beforeLocalTurn().catch(() => {});
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      active = false;
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [beforeLocalTurn]);
  return Object.freeze({ beforeLocalTurn, deploymentCurrent });
}
