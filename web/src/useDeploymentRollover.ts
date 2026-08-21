import { useEffect } from "react";

export function useDeploymentRollover() {
  useEffect(() => {
    let active = true;
    let deploymentSha: string | undefined;
    const readDeploymentSha = async () => {
      const response = await fetch("/api/health", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) return undefined;
      const payload = await response.json() as { deployment_sha?: unknown };
      return typeof payload.deployment_sha === "string" ? payload.deployment_sha : undefined;
    };
    void readDeploymentSha().then((sha) => {
      if (active) deploymentSha = sha;
    }).catch(() => {});
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void readDeploymentSha().then((sha) => {
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
