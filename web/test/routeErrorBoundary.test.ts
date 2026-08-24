import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const application = readFileSync(
  new URL("../src/NanocodexApp.tsx", import.meta.url),
  "utf8",
);
const entry = readFileSync(
  new URL("../src/main.tsx", import.meta.url),
  "utf8",
);
const boundary = readFileSync(
  new URL("../src/RouteErrorBoundary.tsx", import.meta.url),
  "utf8",
);
const routeLoaders = readFileSync(
  new URL("../src/routeLoaders.ts", import.meta.url),
  "utf8",
);
const world = readFileSync(
  new URL("../src/MonsterWorld.tsx", import.meta.url),
  "utf8",
);

test("route failures preserve the retained Agent and replace only the active route", () => {
  const main = application.slice(
    application.indexOf("<main"),
    application.indexOf("</main>") + "</main>".length,
  );
  assert.match(application, /import \{ RouteErrorBoundary \} from "\.\/RouteErrorBoundary"/);
  assert.match(
    main,
    /<RouteErrorBoundary surface=\{agentExperienceMounted \? "agent" : "home"\}>[\s\S]*?<AgentExperience[\s\S]*?<\/RouteErrorBoundary>/,
  );
  assert.match(
    main,
    /<RouteErrorBoundary\s*key=\{surface\}[\s\S]*?routeLoadFailure\?\.surface === surface[\s\S]*?surface=\{surface\}[\s\S]*?<Multiplayer \/>[\s\S]*?<MonsterWorld \/>[\s\S]*?<Evals \/>[\s\S]*?<\/RouteErrorBoundary>/,
  );
  assert.doesNotMatch(main, /key=\{location\.key\}/);
  assert.doesNotMatch(
    application.slice(application.indexOf("<header"), application.indexOf("<main")),
    /RouteErrorBoundary/,
  );

  assert.match(boundary, /class RouteErrorBoundary extends Component/);
  assert.match(boundary, /static getDerivedStateFromError\(error: Error\)/);
  assert.match(boundary, /role="alert"/);
  assert.match(boundary, /This route could not finish loading/);
  assert.match(boundary, /onClick=\{\(\) => window\.location\.reload\(\)\}/);
  assert.match(boundary, />\s*Retry route\s*</);
  assert.doesNotMatch(boundary, /spinner|skeleton|loading\.\.\./i);
});

test("direct route data and mounted World assets reject into the route boundary", () => {
  assert.doesNotMatch(routeLoaders, /Promise\.allSettled/);
  assert.doesNotMatch(routeLoaders, /import\(/);
  assert.match(routeLoaders, /surface === "world"\) \{\s*return \{\};\s*\}/);
  assert.doesNotMatch(routeLoaders, /loadWorldAssets/);
  assert.match(
    world,
    /loadWorldAssets\(\)\.then\([\s\S]*?setAssetError\([\s\S]*?if \(assetError\) throw assetError/,
  );
  assert.match(
    application,
    /preloadDocsRoute\(destination\)\.then\([\s\S]*?setRouteLoadFailure\(routeLoadError\(error, "docs"\)\)[\s\S]*?navigate\(destination\)/,
  );
  assert.match(
    entry,
    /<Suspense fallback=\{null\}>/,
  );
  assert.match(
    entry,
    /prepareRepositorySurface\(directRepositorySurface, requestedCommit\)\.catch/,
  );
  assert.match(
    entry,
    /useState<PreparedDirectRoute \| null>\(\s*directRepositorySurface \? \{\} : null/,
  );
  assert.match(entry, /if \(directRepositorySurface\) return;/);
});
