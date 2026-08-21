import { useEffect } from "react";
import { deploymentHealth } from "./deploymentHealth";

export function useDeploymentRollover() {
  useEffect(() => {
    let active = true;
    let deploymentSha: string | undefined;
    void deploymentHealth.read().then((health) => {
      if (active) deploymentSha = health.deploymentSha;
    }).catch(() => {});
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void deploymentHealth.refresh().then(({ deploymentSha: sha }) => {
        if (!active || !sha) return;
        if (deploymentSha && sha !== deploymentSha) {
          window.location.reload();
          return;
        }
        deploymentSha = sha;
      }).catch(() => {});
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      active = false;
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);
}
