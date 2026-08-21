import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const webDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../../", import.meta.url));

export function deploymentArguments(revision) {
  assert.match(revision, /^[0-9a-f]{40}$/, "deployment revision must be a full commit SHA");
  return [
    "deploy",
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

export function assertDeploymentHealth(health, revision) {
  assert.equal(health?.status, "ok", "deployed Worker must report healthy");
  assert.equal(
    health?.deployment_sha,
    revision,
    "deployed Worker must attest the exact commit SHA",
  );
}

export async function deployWorker({
  fetchImpl = globalThis.fetch,
  origin = process.env.NANOCODEX_WEB_ORIGIN ?? "https://nanocodex.me-7fb.workers.dev",
  run = runWrangler,
} = {}) {
  const revision = git("rev-parse", "HEAD");
  assert.equal(
    git("rev-parse", "origin/master"),
    revision,
    "refusing to deploy a revision that is not the fetched origin/master",
  );

  await run(deploymentArguments(revision));
  const health = await waitForDeployment(fetchImpl, origin, revision);
  process.stdout.write(`${JSON.stringify({
    deploymentSha: health.deployment_sha,
    origin: new URL(origin).origin,
    status: health.status,
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
    const child = spawn(executable, args, {
      cwd: webDirectory,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
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
