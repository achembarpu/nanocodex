import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const accountMenu = source("../src/AccountMenu.tsx");
const accountSession = source("../src/AccountSession.tsx");
const profileConnectors = source("../src/ProfileConnectors.tsx");

test("parallel unauthorized account requests share the current session refresh", () => {
  assert.match(accountSession, /const refreshRequest = useRef<Promise<void> \| undefined>\(undefined\)/);
  assert.match(
    accountSession,
    /if \(refreshRequest\.current\) return refreshRequest\.current;[\s\S]*?refreshRequest\.current = current;[\s\S]*?return current;/,
  );
  assert.match(
    accountSession,
    /if \(refreshRequest\.current === current\) refreshRequest\.current = undefined/,
  );
});

test("account panel reopening fetches only absent account-scoped data", () => {
  assert.match(accountMenu, /const cachedAccountId = useRef<string \| undefined>\(undefined\)/);
  assert.match(accountMenu, /const accountChanged = cachedAccountId\.current !== accountId/);
  assert.match(accountMenu, /if \(accountChanged \|\| keys === null\) missing\.push\(loadKeys\(\)\)/);
  assert.match(
    accountMenu,
    /if \(accountChanged \|\| credentials === null\) missing\.push\(loadCredentials\(\)\)/,
  );
  assert.match(accountMenu, /keyRequest\.current\?\.accountId === accountId/);
  assert.match(accountMenu, /credentialRequest\.current\?\.accountId === accountId/);
  assert.doesNotMatch(accountMenu, /void Promise\.all\(\[loadKeys\(\), loadCredentials\(\)\]\)/);
});

test("the account trigger remains stable while session data is unavailable", () => {
  assert.match(
    accountMenu,
    /<button[\s\S]*?className="account-menu-trigger"[\s\S]*?<\/button>\s*\{open && session\.status !== "checking" \? \(/,
  );
  assert.doesNotMatch(accountMenu, /loading|spinner|skeleton/i);
});

test("connections and API keys share one account surface", () => {
  assert.match(
    accountMenu,
    /<section className="api-key-panel account-profile-content"[\s\S]*?<h2 id="connections-heading">Connections<[\s\S]*?<ProfileConnectors[\s\S]*?<strong>ChatGPT<[\s\S]*?<div className="account-api-keys"/,
  );
  assert.match(accountMenu, /<h2 id="api-key-heading">API keys<[\s\S]*?<strong>OpenAI</);
  assert.match(profileConnectors, /\{children\}[\s\S]*?connectorDefinitions\.map/);
  assert.doesNotMatch(accountMenu, /Model connection|>Refresh<\/button>/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
