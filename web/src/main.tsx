import { createRoot, type Root } from "react-dom/client";
import { Suspense } from "react";
import { BrowserRouter } from "react-router";
import { surfaceFromUrl } from "./navigation";
import type {
  NanocodexApp as NanocodexAppComponent,
  PreparedDirectRoute,
} from "./NanocodexApp";

const loadNanocodexApp = () => import("./NanocodexApp");

const directUrl = new URL(window.location.href);
const directPath = directUrl.pathname === "/"
  ? "/"
  : directUrl.pathname.replace(/\/+$/, "");

if (directPath === "/artifact-runtime") {
  void import("./artifactRuntime");
} else {
  const application = loadNanocodexApp();
  void Promise.all([
    application,
    preloadDirectSurface(directUrl),
  ]).then(
    ([module, preparedRoute]) =>
      renderApp(module.NanocodexApp, preparedRoute),
    () => {
      // A failed route preparation must not strand the document. The normal
      // route lifecycle owns its actionable failure state and retry policy.
      void application.then((module) => renderApp(module.NanocodexApp, {}));
    },
  );
}

function preloadDirectSurface(url: URL): Promise<PreparedDirectRoute> {
  const surface = surfaceFromUrl(url);
  if (surface === "home" || surface === "agent") {
    return Promise.all([
      import("./HomeFrame"),
      import("./AgentExperience"),
    ]).then(() => ({}));
  }
  if (surface === "code") {
    return Promise.all([
      import("./CodeBrowser"),
      import("./PierreWorkerProvider").then((module) =>
        module.preloadPierreWorker()
      ),
      import("./publishedRepository").then(async (module) => {
        const snapshot = await module.preloadPublishedRepositorySnapshot();
        await module.preloadPreferredPublishedFile(snapshot);
        return snapshot;
      }),
    ]).then(([, , repositorySnapshot]) => ({ repositorySnapshot }));
  }
  if (surface === "changelog") {
    return import("./Changelog")
      .then((module) => module.preloadChangelog())
      .then(() => ({}));
  }
  if (surface === "docs") {
    return import("./Docs").then(async (module) => {
      await module.preloadDocsRoute(url.pathname);
      return { DocsComponent: module.Docs };
    });
  }
  if (surface === "commits") {
    return Promise.all([
      import("./CommitCodeStream"),
      import("./PierreWorkerProvider").then((module) =>
        module.preloadPierreWorker()
      ),
      import("./VirtualCommitList"),
      import("./publishedRepository").then(async (module) => {
        const requestedHash = url.searchParams.get("commit")?.toLowerCase();
        const history = await module.loadPublishedCommitHistory(
          requestedHash && /^[a-f0-9]{40}$/.test(requestedHash)
            ? requestedHash
            : undefined,
        );
        void module.preloadPublishedRepositoryPatch(history.initialPage.patchUrl)
          ?.catch(() => undefined);
        return history;
      }),
    ]).then(([, , , commitHistory]) => ({ commitHistory }));
  }
  if (surface === "requests") return Promise.resolve({});
  surface satisfies "evals";
  return import("./Evals").then(() => ({}));
}

function renderApp(
  NanocodexApp: typeof NanocodexAppComponent,
  preparedRoute: PreparedDirectRoute,
) {
  const container = document.getElementById("root") as RootContainer | null;
  if (!container) throw new Error("Nanocodex root container is missing");

  // An invalidated development Fast Refresh boundary can briefly re-evaluate this entry
  // module before Vite reloads the document. Retain the root on the DOM node so
  // that edit never creates a second React owner for the same container.
  const root = container.__nanocodexRoot ??= createRoot(container);
  root.render(
    <BrowserRouter useTransitions={false}>
      <Suspense fallback={null}>
        <NanocodexApp preparedRoute={preparedRoute} />
      </Suspense>
    </BrowserRouter>,
  );
}

type RootContainer = HTMLElement & {
  __nanocodexRoot?: Root;
};
