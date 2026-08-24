import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBuildAttestation,
  assertCleanCheckout,
  assertDeploymentDocument,
  assertDeploymentEntry,
  assertDeploymentHealth,
  parseWorkerVersionId,
  PRODUCTION_ORIGIN,
  rolloutArguments,
  uploadArguments,
} from "./deploy-worker.mjs";

const revision = "a".repeat(40);

test("deployment defaults to the canonical production Worker", () => {
  assert.equal(PRODUCTION_ORIGIN, "https://nanocodex.gakonst.workers.dev");
});

test("deployment rejects a stale build revision or Wrangler config", () => {
  const config = Buffer.from('{"name":"nanocodex"}\n');
  const attestation = {
    revision,
    wranglerConfigSha256: "9600b209414abcc5d304884f6ff5f1e1bcee00a1c3487dc6253b9f7a4b1f0de2",
  };
  assert.doesNotThrow(() => assertBuildAttestation(attestation, revision, config));
  assert.throws(() => assertBuildAttestation(attestation, "b".repeat(40), config));
  assert.throws(() => assertBuildAttestation(attestation, revision, Buffer.from("stale")));
});

test("deployment rejects artifacts built from tracked dirty source", () => {
  assert.doesNotThrow(() => assertCleanCheckout(""));
  assert.throws(() => assertCleanCheckout(" M web/src/main.tsx"), /tracked dirty source/);
});

test("deployment arguments bind the exact tagged commit to Worker health", () => {
  const arguments_ = uploadArguments(revision);

  assert.deepEqual(arguments_.slice(0, 5), [
    "versions",
    "upload",
    "--config",
    "dist/nanocodex/wrangler.json",
    "--strict",
  ]);
  assert.ok(arguments_.includes(revision));
  assert.ok(arguments_.includes(`gakonst/nanocodex@${revision}`));
  assert.ok(arguments_.includes(`DEPLOYMENT_SHA:${revision}`));
});

test("deployment rolls only the uploaded Worker version to production", () => {
  const workerVersionId = "12345678-1234-1234-1234-123456789abc";
  assert.equal(
    parseWorkerVersionId(`Uploaded\nWorker Version ID: ${workerVersionId}\n`),
    workerVersionId,
  );
  assert.deepEqual(rolloutArguments(workerVersionId), [
    "versions",
    "deploy",
    `${workerVersionId}@100%`,
    "--config",
    "dist/nanocodex/wrangler.json",
    "--yes",
  ]);
  assert.throws(() => parseWorkerVersionId("Uploaded without an ID"));
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

test("deployment delivery requires a complete homepage and immutable entry module", () => {
  const document = [
    "<!doctype html>",
    '<script type="module" crossorigin src="/assets/index-Ab_9.js"></script>',
    '<div id="root"></div>',
  ].join("\n");
  const response = new Response(document, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  assert.equal(assertDeploymentDocument(response, document), "/assets/index-Ab_9.js");
  assert.throws(() => assertDeploymentDocument(new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  }), "not found"));

  assert.doesNotThrow(() => assertDeploymentEntry(new Response("export {};", {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "text/javascript",
    },
  })));
  assert.throws(() => assertDeploymentEntry(new Response("export {};", {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript",
    },
  })));
});
