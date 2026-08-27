import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertLocalDevelopmentOwner,
  stopLocalDevelopment,
} from "./down-local.mjs";

test("local down refuses to signal a reused live PID", async () => {
  const statePath = await mkdtemp(resolve(tmpdir(), "nanocodex-down-test-"));
  await writeFile(
    resolve(statePath, "development.lock"),
    `${JSON.stringify({ pid: 42, token: "lease" })}\n`,
  );
  let signalled = false;

  await assert.rejects(
    stopLocalDevelopment(statePath, {
      commandForPid: () => "some-other-service",
      isProcessAlive: () => true,
      kill: () => { signalled = true; },
    }),
    /different live process/,
  );
  assert.equal(signalled, false);
  assert.match(await readFile(resolve(statePath, "development.lock"), "utf8"), /"pid":42/);
});

test("local down signals the owning development process and waits for exit", async () => {
  const statePath = await mkdtemp(resolve(tmpdir(), "nanocodex-down-test-"));
  await writeFile(
    resolve(statePath, "development.lock"),
    `${JSON.stringify({ pid: 43, token: "lease" })}\n`,
  );
  let alive = true;
  const signals = [];
  const result = await stopLocalDevelopment(statePath, {
    commandForPid: () => `${process.execPath} ${resolve("web/scripts/dev-local.mjs")}`,
    isProcessAlive: () => alive,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      alive = false;
    },
    pause: async () => {},
  });

  assert.deepEqual(signals, [[43, "SIGTERM"]]);
  assert.deepEqual(result, { pid: 43, status: "stopped" });
  await assert.rejects(readFile(resolve(statePath, "development.lock")), { code: "ENOENT" });
});

test("local down removes a stale dead lease without signalling", async () => {
  const statePath = await mkdtemp(resolve(tmpdir(), "nanocodex-down-test-"));
  await writeFile(
    resolve(statePath, "development.lock"),
    `${JSON.stringify({ pid: 44, token: "lease" })}\n`,
  );
  const result = await stopLocalDevelopment(statePath, {
    isProcessAlive: () => false,
    kill: () => assert.fail("a dead lease must not be signalled"),
  });

  assert.deepEqual(result, { status: "not-running" });
  await assert.rejects(readFile(resolve(statePath, "development.lock")), { code: "ENOENT" });
});

test("owner validation accepts only the exact Nanocodex development script", () => {
  const expected = resolve("web/scripts/dev-local.mjs");
  assert.doesNotThrow(() => assertLocalDevelopmentOwner(`node ${expected}`, expected));
  assert.throws(
    () => assertLocalDevelopmentOwner("node /tmp/dev-local.mjs", expected),
    /reused PID/,
  );
});
