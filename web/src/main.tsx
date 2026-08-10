import { createRoot } from "react-dom/client";
import { Suspense, lazy } from "react";
import { BrowserRouter } from "react-router";

const NanocodexApp = lazy(() =>
  import("./NanocodexApp").then((module) => ({ default: module.NanocodexApp })),
);

if (window.location.pathname.startsWith("/evals")) {
  void import("./Evals");
  if (window.location.pathname.startsWith("/evals/worksets/")) {
    void import("./EvalAnalytics");
  }
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Suspense fallback={<main className="app-boot" aria-busy="true">Loading Nanocodex…</main>}>
      <NanocodexApp />
    </Suspense>
  </BrowserRouter>,
);
