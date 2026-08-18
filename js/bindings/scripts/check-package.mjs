import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);

export function checkDocumentedBrowserVersion(readme, packageVersion) {
  const documentedVersion = readme.match(
    /nanocodex@([^/"'\s]+)\/browser\/index\.mjs/,
  )?.[1];
  assert.ok(documentedVersion, "README must pin the browser CDN import");

  // pkg-pr-new rewrites package.json immediately before npm pack without
  // rewriting the source README. The README should remain pinned to the latest
  // release while that immutable, commit-addressed preview is packed.
  const isCommitPreview = /^0\.0\.0-preview-[0-9a-f]+$/.test(packageVersion);
  if (!isCommitPreview) {
    assert.equal(documentedVersion, packageVersion);
  }
}

const requiredFiles = [
  "browser/index.mjs",
  "browser/index.d.mts",
  "browser/workspace.mjs",
  "browser/workspace.d.mts",
  "node/index.mjs",
  "node/index.d.mts",
  "node/workspace.mjs",
  "node/workspace.d.mts",
  "worker/index.mjs",
  "worker/index.d.mts",
  "runtime/workspace.mjs",
  "runtime/workspace.d.mts",
  "tools/index.mjs",
  "tools/index.d.mts",
  "tools/dataset.mjs",
  "tools/dataset.d.mts",
  "tools/datasetContract.mjs",
  "tools/datasetEngine.mjs",
  "tools/namedTool.mjs",
  "tools/standardDescriptions.mjs",
  "tools/browser/index.mjs",
  "tools/browser/index.d.mts",
  "tools/vite.mjs",
  "tools/vite.d.mts",
  "wasm.d.mts",
  "pkg-web/nanocodex.js",
  "pkg-web/nanocodex.d.ts",
  "pkg-web/nanocodex_bg.js",
  "pkg-web/nanocodex_bg.wasm",
  "pkg-web/nanocodex_worker.js",
  "pkg-node/nanocodex.js",
  "pkg-node/nanocodex.d.ts",
  "pkg-node/nanocodex_bg.wasm",
];

export async function checkPackage(packageRoot = root) {
  const packageJson = JSON.parse(
    await readFile(new URL("package.json", packageRoot), "utf8"),
  );
  const readme = await readFile(new URL("README.md", packageRoot), "utf8");

  assert.equal(packageJson.name, "nanocodex");
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines?.node, ">=22.13.0");
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.equal(packageJson.exports?.["./browser"]?.import, "./browser/index.mjs");
  assert.equal(packageJson.exports?.["./browser/workspace"]?.import, "./browser/workspace.mjs");
  assert.equal(packageJson.exports?.["./node"]?.import, "./node/index.mjs");
  assert.equal(packageJson.exports?.["./node/workspace"]?.import, "./node/workspace.mjs");
  assert.equal(packageJson.exports?.["./worker"]?.import, "./worker/index.mjs");
  assert.equal(packageJson.exports?.["./tools"]?.import, "./tools/index.mjs");
  assert.equal(packageJson.exports?.["./tools/dataset"]?.import, "./tools/dataset.mjs");
  assert.equal(packageJson.exports?.["./tools/browser"]?.import, "./tools/browser/index.mjs");
  assert.equal(packageJson.exports?.["./tools/vite"]?.import, "./tools/vite.mjs");
  assert.equal(packageJson.exports?.["./wasm"]?.import, "./pkg-web/nanocodex_bg.wasm");
  checkDocumentedBrowserVersion(readme, packageJson.version);

  for (const file of requiredFiles) {
    const metadata = await stat(new URL(file, packageRoot));
    assert(metadata.isFile(), `${file} must be a file`);
    assert(metadata.size > 0, `${file} must not be empty`);
  }

  for (const target of ["web", "node"]) {
    const wasm = await readFile(
      new URL(`pkg-${target}/nanocodex_bg.wasm`, packageRoot),
    );
    assert(wasm.byteLength > 100_000, `pkg-${target} WASM is unexpectedly small`);
    assert.deepEqual([...wasm.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  }

  console.log(`nanocodex@${packageJson.version} package artifacts are complete`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkPackage();
}
