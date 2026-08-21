import { createRoot, type Root } from "react-dom/client";
import { Suspense, lazy } from "react";
import { BrowserRouter } from "react-router";

const loadNanocodexApp = () =>
  import("./NanocodexApp").then((module) => ({ default: module.NanocodexApp }));
const NanocodexApp = lazy(loadNanocodexApp);

const directPath = window.location.pathname === "/"
  ? "/"
  : window.location.pathname.replace(/\/+$/, "");

if (directPath === "/artifact-runtime") {
  void import("./artifactRuntime");
} else if (directPath === "/docs" || directPath.startsWith("/docs/")) {
  void Promise.all([
    loadNanocodexApp(),
    import("./Docs").then((module) => module.preloadDocsRoute(directPath)),
  ]).then(renderApp, renderApp);
} else {
  preloadDirectSurface(directPath);
  renderApp();
}

function preloadDirectSurface(pathname: string) {
  if (pathname === "/" || pathname === "/agent") {
    void Promise.all([import("./HomeFrame"), import("./AgentTerminal")]).catch(() => undefined);
    return;
  }
  if (pathname === "/code") {
    void Promise.all([
      import("./CodeBrowser"),
      import("./PierreWorkerProvider").then((module) =>
        module.preloadPierreWorker()
      ),
      import("./publishedRepository").then(async (module) => {
        const snapshot = await module.preloadPublishedRepositorySnapshot(false);
        await module.preloadPreferredPublishedFile(snapshot);
      }),
    ]).catch(() => undefined);
    return;
  }
  if (pathname === "/changelog") {
    void import("./Changelog")
      .then((module) => module.preloadChangelog())
      .catch(() => undefined);
    return;
  }
  if (pathname === "/commits") {
    void Promise.all([
      import("./CommitCodeStream"),
      import("./PierreWorkerProvider").then((module) =>
        module.preloadPierreWorker()
      ),
      import("./VirtualCommitList"),
      import("./publishedRepository").then(async (module) => {
        const snapshot = await module.preloadPublishedRepositorySnapshot(true);
        await module.preloadPublishedRepositoryPatch(snapshot.commitPatchUrl);
      }),
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
  const container = document.getElementById("root") as RootContainer | null;
  if (!container) throw new Error("Nanocodex root container is missing");

  // An invalidated development Fast Refresh boundary can briefly re-evaluate this entry
  // module before Vite reloads the document. Retain the root on the DOM node so
  // that edit never creates a second React owner for the same container.
  const root = container.__nanocodexRoot ??= createRoot(container);
  root.render(
    <BrowserRouter useTransitions={false}>
      <Suspense fallback={null}>
        <NanocodexApp />
      </Suspense>
    </BrowserRouter>,
  );
}

type RootContainer = HTMLElement & {
  __nanocodexRoot?: Root;
};
