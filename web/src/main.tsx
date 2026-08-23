import { Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AccountSessionProvider } from "./AccountSession";
import { NanocodexApp } from "./NanocodexApp";
import { ArtifactRuntime } from "./artifactRuntime";
import {
  preloadDirectSurface,
  type PreparedDirectRoute,
} from "./routeLoaders";

const directUrl = new URL(window.location.href);
const directPath = directUrl.pathname === "/"
  ? "/"
  : directUrl.pathname.replace(/\/+$/, "");
const container = document.getElementById("root");
if (!container) throw new Error("Nanocodex root container is missing");

createRoot(container).render(
  directPath === "/artifact-runtime"
    ? <ArtifactRuntime />
    : <BrowserApplication url={directUrl} />,
);

function BrowserApplication({ url }: { url: URL }) {
  const [preparedRoute, setPreparedRoute] = useState<PreparedDirectRoute | null>(null);

  useEffect(() => {
    let active = true;
    void preloadDirectSurface(url).then(
      (prepared) => {
        if (active) setPreparedRoute(prepared);
      },
      () => {
        if (active) setPreparedRoute({});
      },
    );
    return () => {
      active = false;
    };
  }, [url]);

  if (!preparedRoute) return null;
  return (
    <BrowserRouter useTransitions={false}>
      <Suspense fallback={null}>
        <AccountSessionProvider>
          <NanocodexApp preparedRoute={preparedRoute} />
        </AccountSessionProvider>
      </Suspense>
    </BrowserRouter>
  );
}
