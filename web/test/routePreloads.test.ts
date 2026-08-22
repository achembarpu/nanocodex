import assert from "node:assert/strict";
import { test } from "node:test";

import {
  routePreloadKeyForPath,
  selectRoutePreloads,
} from "../src/routePreloads.ts";

const document = `<!doctype html><head>
<link rel="modulepreload" href="/app.js" data-nanocodex-route-preload="shell,home,code">
<link rel="stylesheet" href="/home.css" data-nanocodex-route-preload="home">
<link rel="modulepreload" href="/multiplayer.js" data-nanocodex-route-preload="multiplayer">
<link rel="modulepreload" href="/world.js" data-nanocodex-route-preload="world">
<link rel="modulepreload" href="/code.js" data-nanocodex-route-preload="code">
<link rel="modulepreload" href="/artifact.js" data-nanocodex-route-preload="artifact">
</head>`;

test("direct paths select one stable preload audience", () => {
  assert.equal(routePreloadKeyForPath("/"), "home");
  assert.equal(routePreloadKeyForPath("/agent/"), "home");
  assert.equal(routePreloadKeyForPath("/multiplayer/"), "multiplayer");
  assert.equal(routePreloadKeyForPath("/world"), "world");
  assert.equal(routePreloadKeyForPath("/docs/core/owned-agent"), "docs");
  assert.equal(routePreloadKeyForPath("/evals/worksets/current"), "evals");
  assert.equal(routePreloadKeyForPath("/artifact-runtime"), "artifact");
  assert.equal(routePreloadKeyForPath("/not-a-route"), undefined);
});

test("document delivery keeps only the selected static graph", () => {
  const home = selectRoutePreloads(document, "/agent");
  assert.match(home, /\/app\.js/);
  assert.match(home, /\/home\.css/);
  assert.doesNotMatch(home, /\/(?:multiplayer|world|code|artifact)\.js/);
  assert.doesNotMatch(home, /data-nanocodex-route-preload/);

  const code = selectRoutePreloads(document, "/code");
  assert.match(code, /\/app\.js/);
  assert.match(code, /\/code\.js/);
  assert.doesNotMatch(code, /\/home\.css|\/(?:multiplayer|world|artifact)\.js/);

  const multiplayer = selectRoutePreloads(document, "/multiplayer");
  assert.match(multiplayer, /\/app\.js/);
  assert.match(multiplayer, /\/multiplayer\.js/);
  assert.doesNotMatch(multiplayer, /\/home\.css|\/(?:world|code|artifact)\.js/);

  const world = selectRoutePreloads(document, "/world");
  assert.match(world, /\/app\.js/);
  assert.match(world, /\/world\.js/);
  assert.doesNotMatch(world, /\/home\.css|\/(?:multiplayer|code|artifact)\.js/);

  const artifact = selectRoutePreloads(document, "/artifact-runtime");
  assert.match(artifact, /\/artifact\.js/);
  assert.doesNotMatch(artifact, /\/app\.js|\/home\.css|\/(?:multiplayer|world|code)\.js/);
});
