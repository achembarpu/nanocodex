import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDeploymentHealth,
  deploymentArguments,
} from "./deploy-worker.mjs";

const revision = "a".repeat(40);

test("deployment arguments bind the exact tagged commit to Worker health", () => {
  const arguments_ = deploymentArguments(revision);

  assert.deepEqual(arguments_.slice(0, 4), [
    "deploy",
    "--config",
    "dist/nanocodex/wrangler.json",
    "--strict",
  ]);
  assert.ok(arguments_.includes(revision));
  assert.ok(arguments_.includes(`gakonst/nanocodex@${revision}`));
  assert.ok(arguments_.includes(`DEPLOYMENT_SHA:${revision}`));
});

test("deployment health accepts only the exact revision", () => {
  assert.doesNotThrow(() => assertDeploymentHealth({
    deployment_sha: revision,
    status: "ok",
  }, revision));
  assert.throws(() => assertDeploymentHealth({
    deployment_sha: "b".repeat(40),
    status: "ok",
  }, revision));
  assert.throws(() => assertDeploymentHealth({
    deployment_sha: revision,
    status: "error",
  }, revision));
});
