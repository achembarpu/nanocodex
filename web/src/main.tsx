import { createRoot } from "react-dom/client";
import { Suspense, lazy } from "react";
import { BrowserRouter } from "react-router";

const NanocodexApp = lazy(() =>
  import("./NanocodexApp").then((module) => ({ default: module.NanocodexApp })),
);

if (window.location.pathname === "/artifact-runtime") {
  void import("./artifactRuntime");
} else if (window.location.pathname.startsWith("/evals")) {
  void import("./Evals");
  renderApp();
} else {
  renderApp();
}

function renderApp() {
  createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <Suspense fallback={null}>
        <NanocodexApp />
      </Suspense>
    </BrowserRouter>,
  );
}
