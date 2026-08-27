import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demoNavigation, pathForSurface, surfaceFromUrl } from "../src/navigation.ts";

const component = source("../src/HostedToolsDemo.tsx");
const runtime = source("../src/hostedToolsDemoRuntime.ts");
const application = source("../src/NanocodexApp.tsx");
const combined = `${component}\n${runtime}`;

test("Attached Tools is a visible internal Demos route without changing /agent", () => {
  assert.deepEqual(demoNavigation.find(({ surface }) => surface === "tools"), {
    surface: "tools",
    label: "Attached Tools",
    description: "Browser tool host",
  });
  assert.equal(pathForSurface("agent"), "/agent");
  assert.equal(pathForSurface("tools"), "/agent?demo=attached-tools");
  assert.equal(surfaceFromUrl(new URL("https://nanocodex.test/agent")), "agent");
  assert.equal(
    surfaceFromUrl(new URL("https://nanocodex.test/agent?demo=attached-tools")),
    "tools",
  );
  assert.match(application, /import \{ HostedToolsDemo \} from "\.\/HostedToolsDemo"/);
  assert.match(application, /surface === "tools"[\s\S]*?<HostedToolsDemo \/>/);
});

test("the shipped demo uses the public managed SDK and account-scoped attachment target", () => {
  assert.match(component, /import \{ Agent, type ManagedAgent \} from "nanocodex\/managed"/);
  assert.match(component, /import \{ createTools, type Tools \} from "nanocodex\/tools"/);
  assert.match(component, /Agent\.list\(\)/);
  assert.match(component, /Agent\.create\(\)/);
  assert.match(runtime, /tools\.attach\(agent\.toolsTarget\(\)\)/);
  assert.match(runtime, /const client = await connector\.connect\(\)/);
  assert.doesNotMatch(combined, /FakeSocket|managed\.invalid|ncx_live_|apiKey|Authorization/i);
});

test("the route exposes all five broker proofs and validates real browser execution", () => {
  for (const label of [
    "Publish and await catalog readiness",
    "Execute in this browser",
    "Detach and prove refusal",
    "Reconnect the same caller",
    "Fence the stale host",
  ]) assert.match(component, new RegExp(label));
  assert.match(runtime, /added\.length !== 1 \|\| added\[0\]\?\.message !== expected/);
  assert.match(runtime, /executions\(\)\.length !== before/);
  assert.match(runtime, /current\.client\.closed\(\)/);
  assert.match(component, /Provider\s+credentials stay server-side/i);
});

test("the demo remains in the conventional static React and Vite graph", () => {
  assert.doesNotMatch(combined, /createRoot|ReactDOM\.render|import\(|Suspense|spinner|skeleton/i);
  assert.match(component, /if \(account\.status !== "ready" \|\| modelStatus === undefined\) return null/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
