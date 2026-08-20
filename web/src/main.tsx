import { createRoot } from "react-dom/client";
import { Suspense, lazy } from "react";
import { BrowserRouter } from "react-router";

const NanocodexApp = lazy(() =>
  import("./NanocodexApp").then((module) => ({ default: module.NanocodexApp })),
);

const directPath = window.location.pathname === "/"
  ? "/"
  : window.location.pathname.replace(/\/+$/, "");

if (directPath === "/artifact-runtime") {
  void import("./artifactRuntime");
} else {
  preloadDirectSurface(directPath);
  renderApp();
}

function preloadDirectSurface(pathname: string) {
  if (pathname === "/" || pathname === "/agent") {
    void Promise.all([import("./HomeFrame"), import("./AgentTerminal")]).catch(() => undefined);
    return;
  }
  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    void import("./Docs").catch(() => undefined);
    return;
  }
  if (pathname === "/code") {
    void Promise.all([
      import("./CodeBrowser"),
      import("./PierreWorkerProvider"),
      import("./publishedRepository"),
    ]).catch(() => undefined);
    return;
  }
  if (pathname === "/commits") {
    void Promise.all([
      import("./CommitCodeStream"),
      import("./PierreWorkerProvider"),
      import("./VirtualCommitList"),
      import("./publishedRepository"),
    ]).catch(() => undefined);
    return;
  }
  if (pathname === "/evals" || pathname.startsWith("/evals/")) {
    void import("./Evals").catch(() => undefined);
    return;
  }
  void Promise.all([import("./HomeFrame"), import("./AgentTerminal")]).catch(() => undefined);
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
