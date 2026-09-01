import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createSshIdentityPayload,
  decodeSshIdentities,
  sshIdentityPath,
} from "../src/sshIdentities.ts";

const fingerprint = `SHA256:${"A".repeat(43)}`;
const privateKey = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "A".repeat(80),
  "-----END RSA PRIVATE KEY-----",
].join("\n");

test("SSH status decoding retains only target metadata", () => {
  const identities = decodeSshIdentities([{
    reference: "production",
    hostname: "ssh.example.com",
    port: 2222,
    username: "deploy",
    host_key_sha256: fingerprint,
    private_key: "must-not-enter-account-state",
  }]);

  assert.deepEqual(identities, [{
    reference: "production",
    hostname: "ssh.example.com",
    port: 2222,
    username: "deploy",
    hostKeySha256: fingerprint,
  }]);
  assert.doesNotMatch(JSON.stringify(identities), /private|must-not-enter/);
});

test("SSH provisioning validates the reference, lowercase target, port, user, fingerprint, and key", () => {
  assert.deepEqual(createSshIdentityPayload({
    reference: "production",
    hostname: "ssh.example.com",
    port: 2222,
    username: "deploy",
    hostKeySha256: fingerprint,
  }, privateKey), {
    private_key: privateKey,
    hostname: "ssh.example.com",
    port: 2222,
    username: "deploy",
    host_key_sha256: fingerprint,
  });
  assert.equal(sshIdentityPath("production.eu-1"), "/v1/credentials/ssh/production.eu-1");
  assert.throws(() => sshIdentityPath("__proto__"), /Invalid SSH identity reference/);
  assert.throws(() => sshIdentityPath("constructor"), /Invalid SSH identity reference/);

  assert.throws(() => createSshIdentityPayload({
    reference: "production",
    hostname: "SSH.example.com",
    port: 2222,
    username: "deploy",
    hostKeySha256: fingerprint,
  }, privateKey), /lowercase DNS name or IPv4/);
  assert.throws(() => createSshIdentityPayload({
    reference: "production",
    hostname: "ssh.example.com",
    port: 0,
    username: "deploy",
    hostKeySha256: fingerprint,
  }, privateKey), /whole number from 1 to 65535/);
  assert.throws(() => createSshIdentityPayload({
    reference: "production",
    hostname: "ssh.example.com",
    port: 22,
    username: "deploy",
    hostKeySha256: "MD5:untrusted",
  }, privateKey), /SHA256 fingerprint/);
  assert.throws(() => createSshIdentityPayload({
    reference: "production",
    hostname: "ssh.example.com",
    port: 22,
    username: "deploy",
    hostKeySha256: fingerprint,
  }, "not a key"), /private-key file/);
});

test("Account provisions from a local file and never persists or renders key contents", () => {
  const account = source("../src/AccountMenu.tsx");
  const manager = source("../src/SshIdentityManager.tsx");

  assert.match(account, /apiRequest\("\/v1\/credentials"\)/);
  assert.match(account, /ssh: decodeSshIdentities\(value\.ssh\)/);
  assert.match(account, /<SshIdentityManager[\s\S]*?presentation="wizard"/);
  assert.match(manager, /name="private-key"[\s\S]*?type="file"/);
  assert.match(manager, /privateKey = await keyFile\.text\(\)/);
  assert.match(manager, /method: "PUT"[\s\S]*?JSON\.stringify\(payload\)/);
  assert.match(manager, /method: "DELETE"/);
  assert.match(manager, /credentials: "same-origin"/);
  assert.match(manager, /cache: "no-store"/);
  assert.match(manager, /finally \{[\s\S]*?privateKey = ""/);
  assert.match(manager, /form\.reset\(\)/);
  assert.match(manager, /The broker rejected this identity\. Check the public lowercase host, port, username, SHA256 fingerprint, and unencrypted PEM key file\./);
  assert.doesNotMatch(manager, /localStorage|sessionStorage|indexedDB|navigator\.clipboard/);
  assert.doesNotMatch(manager, /setPrivateKey|value=\{privateKey\}|defaultValue=\{privateKey\}/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
