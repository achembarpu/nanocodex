import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const budgets = Object.freeze({
  initialJavaScriptFiles: 2,
  initialJavaScript: 260_000,
  initialJavaScriptGzip: 83_000,
  initialCssFiles: 2,
  initialCss: 60_000,
  initialCssGzip: 12_000,
  agentJavaScript: 830_000,
  // OPFS, artifacts, voice routing, and the paid MCP seam add lazy Worker edges.
  agentWorker: 51_000,
  agentWorkerGzip: 16_500,
  // just-bash and its built-in Unix command set stay behind Agent startup.
  browserShellJavaScript: 1_600_000,
  browserShellJavaScriptGzip: 450_000,
  artifactCoreJavaScript: 7_000,
  artifactCoreJavaScriptGzip: 2_800,
  // Includes the canonical Rust apply_patch grammar and planner in browser WASM.
  wasm: 2_550_000,
  wasmGzip: 550_000,
  mppControlsJavaScript: 1_300_000,
  workerTempoJavaScript: 800_000,
});

const clientDirectory = fileURLToPath(
  new URL("../dist/client/", import.meta.url),
);
const assetsDirectory = join(clientDirectory, "assets");
const manifest = JSON.parse(
  await readFile(join(clientDirectory, ".vite", "manifest.json"), "utf8"),
);

const entryKey = manifestKey("index.html");
const agentKey = manifestKey("src/AgentTerminal.tsx");
const artifactCoreKey = manifestKey("nanocodex-artifacts/dist/index.js");
const mppKey = manifestKey("src/MppControls.tsx");
const entry = manifest[entryKey];
const agent = manifest[agentKey];
const artifactCore = manifest[artifactCoreKey];
const mpp = manifest[mppKey];

assert(entry?.isEntry, "the browser entry is missing from the Vite manifest");
assert(agent?.isDynamicEntry, "the Agent terminal must remain a dynamic entry");
assert(artifactCore?.isDynamicEntry, "the artifact core must remain a dynamic entry");
assert(mpp?.isDynamicEntry, "the MPP controls must remain a dynamic entry");

const allEntryImports = importClosure(entryKey, true);
assert(
  allEntryImports.has(agentKey),
  "the Agent terminal is no longer reachable from the browser entry",
);
assert(
  allEntryImports.has(mppKey),
  "the MPP controls are no longer reachable through the opt-in Agent path",
);

const initialStatic = importClosure(entryKey, false);
const agentStatic = importClosure(agentKey, false);
const artifactCoreStatic = importClosure(artifactCoreKey, false);
for (const shared of agentStatic) artifactCoreStatic.delete(shared);
assert(
  !initialStatic.has(agentKey),
  "the initial route must not statically import the Agent terminal",
);
assert(
  !initialStatic.has(mppKey) && !agentStatic.has(mppKey),
  "the default OpenAI graph must not statically import the MPP controls",
);
assert(
  !agentStatic.has(artifactCoreKey) && artifactCoreStatic.has(artifactCoreKey),
  "artifact persistence and validation must remain lazy from the Agent terminal",
);

const initialJavaScript = await closureStats(initialStatic, "file");
const initialCssFiles = cssClosure(initialStatic);
const initialCss = await fileStats(initialCssFiles);
const agentJavaScript = await closureStats(agentStatic, "file");
const artifactCoreJavaScript = await closureStats(artifactCoreStatic, "file");
const mppJavaScript = await closureStats(importClosure(mppKey, false), "file");

withinCount(
  "initial JavaScript chunks",
  initialJavaScript.fileCount,
  budgets.initialJavaScriptFiles,
);
within(
  "initial JavaScript",
  initialJavaScript.bytes,
  budgets.initialJavaScript,
);
within(
  "initial JavaScript gzip",
  initialJavaScript.gzipBytes,
  budgets.initialJavaScriptGzip,
);
withinCount("initial CSS files", initialCss.fileCount, budgets.initialCssFiles);
within("initial CSS", initialCss.bytes, budgets.initialCss);
within("initial CSS gzip", initialCss.gzipBytes, budgets.initialCssGzip);
within("Agent JavaScript", agentJavaScript.bytes, budgets.agentJavaScript);
within("artifact core JavaScript", artifactCoreJavaScript.bytes, budgets.artifactCoreJavaScript);
within(
  "artifact core JavaScript gzip",
  artifactCoreJavaScript.gzipBytes,
  budgets.artifactCoreJavaScriptGzip,
);
within(
  "MPP controls JavaScript",
  mppJavaScript.bytes,
  budgets.mppControlsJavaScript,
);

const initialSource = await closureSource(initialStatic);
for (const marker of [
  "Tempo Wallet connected",
  "virtualMasterPool",
  "VirtualMasterPool",
]) {
  assert(
    !initialSource.includes(marker),
    `the initial route unexpectedly contains the paid runtime marker ${marker}`,
  );
}

const html = await readFile(join(clientDirectory, "index.html"), "utf8");
const headers = await readFile(join(clientDirectory, "_headers"), "utf8");
assert(
  !html.includes(mpp.file),
  "index.html must not preload the opt-in MPP controls",
);
assert.match(
  headers,
  /\/assets\/\*[\s\S]*Cache-Control: public, max-age=31536000, immutable/,
  "hashed browser assets must retain immutable browser caching",
);

const assets = await readdir(assetsDirectory);
const workerFile = exactlyOne(
  assets.filter((file) => /^agent\.worker-.*\.js$/.test(file)),
  "browser Agent Worker entry",
);
const workerPath = join(assetsDirectory, workerFile);
const workerSource = await readFile(workerPath, "utf8");
const worker = byteStats(workerSource);
within("OpenAI Agent Worker", worker.bytes, budgets.agentWorker);
within(
  "OpenAI Agent Worker gzip",
  worker.gzipBytes,
  budgets.agentWorkerGzip,
);

const browserShellImport = workerSource.match(
  /import\((?:`|'|")\.\/(browserShell-[^`'"]+\.js)(?:`|'|")\)/,
);
assert(browserShellImport, "the Agent Worker must lazy-load the browser shell");
const browserShell = await fileStats([`assets/${browserShellImport[1]}`]);
within(
  "Browser shell JavaScript",
  browserShell.bytes,
  budgets.browserShellJavaScript,
);
within(
  "Browser shell JavaScript gzip",
  browserShell.gzipBytes,
  budgets.browserShellJavaScriptGzip,
);

const tempoImport = workerSource.match(
  /import\((?:`|'|")\.\/(tempo-[^`'"]+\.js)(?:`|'|")\)/,
);
assert(tempoImport, "the Agent Worker must retain an explicit lazy Tempo edge");
const tempoFile = tempoImport[1];
assert(
  assets.includes(tempoFile),
  `the lazy Worker Tempo chunk ${tempoFile} is missing`,
);
assert(
  !html.includes(tempoFile),
  "index.html must not preload the opt-in Worker Tempo chunk",
);
const tempo = await fileStats([`assets/${tempoFile}`]);
within(
  "Worker Tempo JavaScript",
  tempo.bytes,
  budgets.workerTempoJavaScript,
);

const wasmFile = exactlyOne(
  assets.filter((file) => /^nanocodex_bg-.*\.wasm$/.test(file)),
  "Nanocodex WASM asset",
);
const wasmPath = join(assetsDirectory, wasmFile);
const wasmBytes = await readFile(wasmPath);
const wasmImports = WebAssembly.Module.imports(
  new WebAssembly.Module(wasmBytes),
);
const missingWasmImports = wasmImports.filter((entry) =>
  entry.module !== "./nanocodex_bg.js"
  || entry.kind !== "function"
  || !workerSource.includes(entry.name)
);
assert.deepEqual(
  missingWasmImports,
  [],
  "the Agent Worker wasm-bindgen glue does not satisfy the bundled WASM imports",
);
const wasm = await fileStats([`assets/${wasmFile}`]);
within("Nanocodex WASM", wasm.bytes, budgets.wasm);
within("Nanocodex WASM gzip", wasm.gzipBytes, budgets.wasmGzip);

console.log(JSON.stringify({
  initial: {
    javascriptFiles: initialJavaScript.fileCount,
    javascriptBytes: initialJavaScript.bytes,
    javascriptGzipBytes: initialJavaScript.gzipBytes,
    cssFiles: initialCss.fileCount,
    cssBytes: initialCss.bytes,
    cssGzipBytes: initialCss.gzipBytes,
    staticChunks: [...initialStatic],
  },
  agent: {
    javascriptBytes: agentJavaScript.bytes,
    workerBytes: worker.bytes,
    workerGzipBytes: worker.gzipBytes,
  },
  artifacts: {
    coreJavaScriptBytes: artifactCoreJavaScript.bytes,
    coreJavaScriptGzipBytes: artifactCoreJavaScript.gzipBytes,
  },
  mpp: {
    controlsJavaScriptBytes: mppJavaScript.bytes,
    controlsEntry: mpp.file,
    workerTempoJavaScriptBytes: tempo.bytes,
    workerTempoEntry: tempoFile,
  },
  wasm: {
    bytes: wasm.bytes,
    gzipBytes: wasm.gzipBytes,
    imports: wasmImports.length,
  },
}));

function manifestKey(suffix) {
  const matches = Object.keys(manifest).filter(
    (key) => key === suffix || key.endsWith(`/${suffix}`),
  );
  return exactlyOne(matches, `Vite manifest entry ${suffix}`);
}

function importClosure(root, includeDynamic) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    const item = manifest[key];
    assert(item, `the Vite manifest references missing entry ${key}`);
    seen.add(key);
    for (const imported of item.imports ?? []) visit(imported);
    if (includeDynamic) {
      for (const imported of item.dynamicImports ?? []) visit(imported);
    }
  };
  visit(root);
  return seen;
}

function cssClosure(keys) {
  const files = new Set();
  for (const key of keys) {
    for (const file of manifest[key]?.css ?? []) files.add(file);
  }
  return [...files];
}

async function closureStats(keys, field) {
  return fileStats(
    [...keys]
      .map((key) => manifest[key]?.[field])
      .filter((file) => typeof file === "string"),
  );
}

async function closureSource(keys) {
  const sources = await Promise.all(
    [...keys].map((key) => readFile(join(clientDirectory, manifest[key].file))),
  );
  return Buffer.concat(sources).toString("utf8");
}

async function fileStats(files) {
  const uniqueFiles = [...new Set(files)];
  const contents = await Promise.all(
    uniqueFiles.map((file) => readFile(join(clientDirectory, file))),
  );
  const bytes = contents.reduce((total, content) => total + content.byteLength, 0);
  const gzipBytes = contents.reduce(
    (total, content) => total + gzipSync(content, { level: 9 }).byteLength,
    0,
  );
  return { bytes, fileCount: uniqueFiles.length, gzipBytes };
}

function byteStats(source) {
  const content = Buffer.from(source);
  return {
    bytes: content.byteLength,
    gzipBytes: gzipSync(content, { level: 9 }).byteLength,
  };
}

function within(name, actual, maximum) {
  assert(
    actual <= maximum,
    `${name} is ${actual.toLocaleString()} bytes; expected at most ${maximum.toLocaleString()}`,
  );
}

function withinCount(name, actual, maximum) {
  assert(
    actual <= maximum,
    `${name} is ${actual}; expected at most ${maximum}`,
  );
}

function exactlyOne(values, name) {
  assert.equal(
    values.length,
    1,
    `expected exactly one ${name}, found ${values.length}`,
  );
  return values[0];
}
