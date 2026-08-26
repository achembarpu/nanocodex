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
  assert.match(accountMenu, /<button[\s\S]*?className="account-menu-trigger"[\s\S]*?<\/button>/);
  assert.match(accountMenu, /\{\(inline \|\| open\) && session\.status !== "checking" \? \(/);
  assert.doesNotMatch(accountMenu, /loading|spinner|skeleton/i);
});

test("connections and API keys share one account surface", () => {
  assert.match(
    accountMenu,
    /from "@nanocodex-connect\/AccountConnectionSurface";[\s\S]*?<AccountConnectionSurface[\s\S]*?<AccountConnectionSection[\s\S]*?title="Connections"[\s\S]*?<ProfileConnectors[\s\S]*?<AccountConnectionCard[\s\S]*?title="ChatGPT"[\s\S]*?<AccountConnectionCard[\s\S]*?title="OpenAI API key"[\s\S]*?<AccountConnectionSection[\s\S]*?title="API keys"/,
  );
  assert.match(accountMenu, /title="API keys"[\s\S]*?Nanocodex API key/);
  assert.match(profileConnectors, /<AccountConnectionGrid>[\s\S]*?\{children\}[\s\S]*?connectorDefinitions\.map/);
  assert.doesNotMatch(accountMenu, /Model connection|>Refresh<\/button>/);
});

test("account sign-out retains the shared remembered-passkey catalog", () => {
  assert.doesNotMatch(accountSession, /maxAccounts:\s*1/);
  assert.doesNotMatch(accountSession, /signOut[\s\S]*?wallet_disconnect/);
  assert.match(accountSession, /signOut[\s\S]*?logoutBrowserAccountSession\(\)/);
});

test("guest account mutations stay visibly disabled behind passkey actions", () => {
  assert.match(profileConnectors, /if \(requiresLogin\)[\s\S]*?<button[\s\S]*?disabled[\s\S]*?definition\.description/);
  assert.doesNotMatch(profileConnectors, /onLoginRequired/);
  assert.match(accountMenu, /disabled=\{!accountPersistent \|\| providerOperation !== null\}/);
  assert.match(accountMenu, /id="api-key-label"[\s\S]*?disabled=\{!accountPersistent\}/);
  assert.match(accountMenu, /disabled=\{!accountPersistent \|\| keyOperation !== null\}>Create/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
