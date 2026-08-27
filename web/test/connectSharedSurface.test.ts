import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = source("../connect-dialog/src/App.tsx");
const chooser = source("../connect-dialog/src/AccountChooser.tsx");
const accountMenu = source("../src/AccountMenu.tsx");
const profileConnectors = source("../src/ProfileConnectors.tsx");
const connectorCompletion = source("../connect-dialog/src/connectorCompletion.ts");

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

test("Account and embedded Connect share strict in-place OAuth completion", () => {
  assert.match(app, /connectorCompletionFor\(event/);
  assert.match(profileConnectors, /from "@nanocodex-connect\/connectorCompletion"/);
  assert.match(profileConnectors, /window\.open\([\s\S]*?"about:blank"[\s\S]*?popup\.location\.href = authorizationUrl\.href/);
  assert.match(profileConnectors, /connectorCompletionFor\(event,[\s\S]*?origin: window\.location\.origin[\s\S]*?source: attempt\.popup/);
  assert.match(profileConnectors, /refreshConnectors\(attempt\.abort\.signal\)[\s\S]*?statuses\[attempt\.connector\]\.connected/);
  assert.match(profileConnectors, /window\.opener\.postMessage\(connectorCompletion\(id as ConnectorId, result\), window\.location\.origin\)/);
  assert.match(profileConnectors, /authorization popup was blocked[\s\S]*?authorization popup was closed before it completed/);
  assert.doesNotMatch(profileConnectors, /window\.location\.assign\(authorizationUrl\.href\)/);
  assert.doesNotMatch(profileConnectors, /localStorage|sessionStorage/);
  assert.match(connectorCompletion, /event\.origin === expected\.origin[\s\S]*?event\.source === expected\.source[\s\S]*?event\.data\.connector === expected\.connector/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
