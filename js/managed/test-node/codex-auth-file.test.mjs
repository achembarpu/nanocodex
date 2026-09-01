import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { readCodexSubscription } from "../scripts/codex-auth-file.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

test("reads only the current protected subscription access credential", async () => {
  const path = await authFile("access-one");
  const auth = await readCodexSubscription(path);
  assert.equal(auth.accountId, "account-123");
  assert.equal(auth.fedramp, false);
  assert.match(auth.accessToken, /^[^.]+\.[^.]+\./);
  assert.equal("refreshToken" in auth, false);
});

test("rejects an auth file readable by other users", { skip: process.platform === "win32" }, async () => {
  const path = await authFile("access-token", 0o644);
  await assert.rejects(readCodexSubscription(path), /group or other users/);
});

test("rejects an access token near expiry", async () => {
  const path = await authFile("expiring", 0o600, 60);
  await assert.rejects(readCodexSubscription(path), /expires too soon/);
});

async function authFile(tokenMarker, mode = 0o600, ttlSeconds = 3_600) {
  const directory = await mkdtemp(join(tmpdir(), "nanocodex-cloudflare-auth-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "auth.json");
  const expiresAt = Math.floor(Date.now() / 1_000) + ttlSeconds;
  await writeFile(path, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt({ exp: expiresAt, marker: tokenMarker }),
      account_id: "account-123",
      id_token: jwt({
        exp: expiresAt,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-123",
          chatgpt_account_is_fedramp: false,
        },
      }),
      refresh_token: "must-not-be-used",
    },
  }), { mode });
  return path;
}

function jwt(payload) {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
