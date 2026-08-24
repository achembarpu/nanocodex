import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const webDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../../", import.meta.url));
export const PRODUCTION_ORIGIN = JSON.parse(
  readFileSync(new URL("../production.json", import.meta.url), "utf8"),
).origin;

export function uploadArguments(revision) {
  assert.match(revision, /^[0-9a-f]{40}$/, "deployment revision must be a full commit SHA");
  return [
    "versions",
    "upload",
    "--config",
    "dist/nanocodex/wrangler.json",
    "--strict",
    "--tag",
    revision,
    "--message",
    `gakonst/nanocodex@${revision}`,
    "--var",
    `DEPLOYMENT_SHA:${revision}`,
  ];
}

export function rolloutArguments(workerVersionId) {
  assert.match(
    workerVersionId,
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    "Worker version ID must be a UUID",
  );
  return [
    "versions",
    "deploy",
    `${workerVersionId}@100%`,
    "--config",
    "dist/nanocodex/wrangler.json",
    "--yes",
  ];
}

export function parseWorkerVersionId(output) {
  const workerVersionId = output.match(/Worker Version ID:\s+([0-9a-f-]{36})/)?.[1];
  assert.ok(workerVersionId, "wrangler upload must report its Worker version ID");
  rolloutArguments(workerVersionId);
  return workerVersionId;
}

export function assertDeploymentHealth(health, revision) {
  assert.equal(health?.status, "ok", "deployed Worker must report healthy");
  assert.equal(
    health?.deployment_sha,
    revision,
    "deployed Worker must attest the exact commit SHA",
  );
}

export function assertBuildAttestation(attestation, revision, wranglerConfig) {
  assert.deepEqual(attestation, {
    revision,
    wranglerConfigSha256: createHash("sha256").update(wranglerConfig).digest("hex"),
  }, "deployment build must match the current revision and Wrangler config");
}

export function assertCleanCheckout(status) {
  assert.equal(status, "", "refusing to deploy a build from tracked dirty source");
}

export function assertDeploymentDocument(response, document) {
  assert.equal(response.status, 200, `deployed homepage returned HTTP ${response.status}`);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/,
    "deployed homepage must be HTML",
  );
  assert.match(document, /<div id="root"><\/div>/, "deployed homepage must contain the React root");
  const entry = document.match(
    /<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="([^"]+)")[^>]*>/,
  )?.[1];
  assert.match(
    entry ?? "",
    /^\/assets\/[A-Za-z0-9_-]+\.js$/,
    "deployed homepage must load a hashed entry module",
  );
  return entry;
}

export function assertDeploymentEntry(response) {
  assert.equal(response.status, 200, `deployed entry module returned HTTP ${response.status}`);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^(?:application|text)\/javascript\b/,
    "deployed entry module must be JavaScript",
  );
  assert.match(
    response.headers.get("cache-control") ?? "",
    /(?:^|,)\s*immutable(?:,|$)/,
    "deployed entry module must be immutable",
  );
}

export async function deployWorker({
  fetchImpl = globalThis.fetch,
  origin = process.env.NANOCODEX_WEB_ORIGIN ?? PRODUCTION_ORIGIN,
  run = runWrangler,
} = {}) {
  const revision = git("rev-parse", "HEAD");
  assertCleanCheckout(git("status", "--porcelain", "--untracked-files=no"));
  assert.equal(
    git("rev-parse", "origin/master"),
    revision,
    "refusing to deploy a revision that is not the fetched origin/master",
  );
  assertBuildAttestation(
    JSON.parse(readFileSync(new URL("../dist/nanocodex/build-attestation.json", import.meta.url))),
    revision,
    readFileSync(new URL("../wrangler.jsonc", import.meta.url)),
  );

  const uploaded = await run(uploadArguments(revision));
  const workerVersionId = parseWorkerVersionId(uploaded);
  await run(rolloutArguments(workerVersionId));
  const health = await waitForDeployment(fetchImpl, origin, revision);
  process.stdout.write(`${JSON.stringify({
    deploymentSha: health.deployment_sha,
    origin: new URL(origin).origin,
    status: health.status,
    workerVersionId,
  }, null, 2)}\n`);
  return health;
}

async function waitForDeployment(fetchImpl, origin, revision) {
  let failure;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const url = new URL("/api/health", origin);
      url.searchParams.set("revision", revision);
      url.searchParams.set("attempt", String(attempt));
      const response = await fetchImpl(url, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200, `deployment health returned HTTP ${response.status}`);
      const health = await response.json();
      assertDeploymentHealth(health, revision);

      const documentResponse = await fetchImpl(new URL("/", origin), {
        cache: "no-store",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
        signal: AbortSignal.timeout(5_000),
      });
      const document = await documentResponse.text();
      const entry = assertDeploymentDocument(documentResponse, document);
      const entryResponse = await fetchImpl(new URL(entry, origin), {
        cache: "no-store",
        method: "HEAD",
        headers: {
          accept: "*/*",
          "sec-fetch-dest": "script",
          "sec-fetch-mode": "no-cors",
        },
        signal: AbortSignal.timeout(5_000),
      });
      assertDeploymentEntry(entryResponse);
      return health;
    } catch (error) {
      failure = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw failure;
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: repositoryDirectory,
    encoding: "utf8",
  }).trim();
}

function runWrangler(args) {
  const executable = fileURLToPath(new URL(
    process.platform === "win32" ? "../node_modules/.bin/wrangler.cmd" : "../node_modules/.bin/wrangler",
    import.meta.url,
  ));
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(executable, args, {
      cwd: webDirectory,
      stdio: ["inherit", "pipe", "inherit"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`wrangler exited with ${code ?? signal}`));
    });
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  await deployWorker();
}
