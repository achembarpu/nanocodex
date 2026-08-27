import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = source("../connect-dialog/src/App.tsx");
const chooser = source("../connect-dialog/src/AccountChooser.tsx");
const accountMenu = source("../src/AccountMenu.tsx");
const profileConnectors = source("../src/ProfileConnectors.tsx");

test("Account and embedded Connect render the same identity and connection components", () => {
  assert.match(app, /from "\.\/AccountChooser"/);
  assert.match(app, /from "\.\/AccountConnectionSurface"/);
  assert.match(app, /from "\.\/ConnectionLogo"/);
  assert.match(accountMenu, /from "@nanocodex-connect\/AccountChooser"/);
  assert.match(accountMenu, /from "@nanocodex-connect\/AccountConnectionSurface"/);
  assert.match(accountMenu, /from "@nanocodex-connect\/ConnectionLogo"/);
  assert.match(profileConnectors, /from "@nanocodex-connect\/AccountConnectionSurface"/);
  assert.doesNotMatch(app, />Existing<|>New<|function ConnectorLogo/);
});

test("the shared chooser keeps current, remembered, system, creation, and cancellation actions explicit", () => {
  assert.match(chooser, /account\.current \? " is-current"/);
  assert.match(chooser, /orderedPasskeys\(storedPasskeys\)\.map/);
  assert.match(chooser, />Use another passkey</);
  assert.match(chooser, />Create a new account</);
  assert.match(chooser, />Cancel<\/button>/);
});

test("scoped Connect filters signed request context and retains approval return hooks", () => {
  assert.match(app, /request\.permission\.connectors\.length[\s\S]*?<WizardConnectorList/);
  assert.match(app, /request\.mcpConnections\.length[\s\S]*?<McpConnectionList/);
  assert.match(app, /appVisibilityPermissions\(request\.auth\.resources\)/);
  assert.match(app, /request\.auth\.resources\.map/);
  assert.match(app, /await host\.respond\(result\)/);
  assert.match(app, /host\.reject\(new Error\("The request was not approved\."\)\)/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
