import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const budgets = Object.freeze({
  initialJavaScriptFiles: 1,
  initialJavaScript: 10_000,
  initialJavaScriptGzip: 4_000,
  signedOutJavaScriptFiles: 10,
  signedOutJavaScript: 280_000,
  signedOutJavaScriptGzip: 91_000,
  initialCssFiles: 2,
  // Includes compact Code/Commits controls for portrait and phone landscape.
  initialCss: 60_500,
  initialCssGzip: 12_000,
  // Direct signed-out routes include the document, their complete static JS/CSS
  // closure, and only the route-owned repository data requests.
  sourceRouteRequests: 21,
  sourceRouteJavaScriptGzip: 330_000,
  sourceRouteCssGzip: 12_200,
  commitsRouteRequests: 19,
  commitsRouteJavaScriptGzip: 285_000,
  commitsRouteCssGzip: 12_000,
  // The overview prepares its complete highlighted page with only the shell
  // grammar; other documentation grammars stay route-specific.
  docsRouteRequests: 19,
  docsRouteJavaScriptGzip: 165_000,
  docsRouteCssGzip: 15_000,
  changelogRouteRequests: 15,
  changelogRouteJavaScriptGzip: 90_000,
  changelogRouteCssGzip: 14_000,
  evalsRouteRequests: 14,
  evalsRouteJavaScriptGzip: 107_000,
  evalsRouteCssGzip: 15_500,
  agentJavaScript: 680_000,
  // Worker/WASM preparation must begin from this small graph while the much
  // larger terminal UI downloads in parallel.
  agentRuntimeJavaScriptFiles: 4,
  agentRuntimeJavaScript: 45_000,
  agentRuntimeJavaScriptGzip: 15_000,
  // OPFS, artifacts, durability, typed voice lifecycle routing, subscription auth, and paid MCP stay in the Worker.
  // The app-local ANSI terminal bridge stays in a lazy chunk loaded only after
  // an authenticated terminal starts.
  agentWorker: 24_000,
  agentWorkerGzip: 8_000,
  // Includes the model-visible schema so Agent startup pays one request for
  // the complete lazy facade instead of fetching a second contract chunk.
  datasetFacadeJavaScript: 2_500,
  datasetFacadeJavaScriptGzip: 1_100,
  // Includes stateless physical cursors for bounded Parquet and JSONL continuation.
  datasetToolJavaScript: 24_500,
  datasetToolJavaScriptGzip: 8_300,
  parquetJavaScript: 60_000,
  parquetJavaScriptGzip: 18_000,
  parquetCompressorsJavaScript: 116_000,
  parquetCompressorsJavaScriptGzip: 75_500,
  // Git restoration, project instructions, and the model-visible browser tool
  // contracts are ready with the Agent. The much larger Bash interpreter is
  // fetched only if exec_command is invoked.
  browserShellJavaScript: 320_000,
  browserShellJavaScriptGzip: 98_000,
  browserBashJavaScript: 1_340_000,
  browserBashJavaScriptGzip: 370_000,
  // Includes the canonical Rust apply_patch planner and the complete
  // JSON-Schema-backed subagent runtime. Keep these close to the optimized
  // artifact so future growth still fails this gate.
  wasm: 3_750_000,
  wasmGzip: 1_350_000,
});

const clientDirectory = fileURLToPath(
  new URL("../dist/client/", import.meta.url),
);
const workerDirectory = fileURLToPath(
  new URL("../dist/nanocodex/", import.meta.url),
);
const assetsDirectory = join(clientDirectory, "assets");
const manifest = JSON.parse(
  await readFile(join(clientDirectory, ".vite", "manifest.json"), "utf8"),
);

const entryKey = manifestKey("index.html");
const applicationKey = manifestKey("src/NanocodexApp.tsx");
const homeFrameKey = manifestKey("src/HomeFrame.tsx");
const experienceKey = manifestKey("src/AgentExperience.tsx");
const agentKey = manifestKey("src/AgentTerminal.tsx");
const docsSyntaxKey = manifestKey("src/docsSyntax.tsx");
const docsOverviewLanguageKey = exactlyOne(
  Object.keys(manifest).filter((key) => manifest[key]?.name === "shellscript"),
  "documentation overview shell grammar",
);
const agentRuntimeKey = exactlyOne(
  Object.keys(manifest).filter((key) => manifest[key]?.name === "agentRuntime"),
  "authenticated Agent runtime chunk",
);
const entry = manifest[entryKey];
const experience = manifest[experienceKey];
const agent = manifest[agentKey];

assert(entry?.isEntry, "the browser entry is missing from the Vite manifest");
assert(experience?.isDynamicEntry, "the credential experience must remain a dynamic entry");
assert(agent?.isDynamicEntry, "the Agent terminal must remain a dynamic entry");

const allEntryImports = importClosure(entryKey, true);
assert(
  allEntryImports.has(experienceKey),
  "the credential experience is no longer reachable from the browser entry",
);
assert(
  allEntryImports.has(agentKey),
  "the Agent terminal is no longer reachable from the browser entry",
);
const initialStatic = importClosure(entryKey, false);
const applicationStatic = importClosure(applicationKey, false);
const homeFrameStatic = importClosure(homeFrameKey, false);
const experienceStatic = importClosure(experienceKey, false);
const agentStatic = importClosure(agentKey, false);
const agentRuntimeStatic = importClosure(agentRuntimeKey, false);
const sourceRoute = await directRouteStats([
  "index.html",
  "src/NanocodexApp.tsx",
  "src/CodeBrowser.tsx",
  "src/publishedRepository.ts",
], 2);
const commitsRoute = await directRouteStats([
  "index.html",
  "src/NanocodexApp.tsx",
  "src/CommitCodeStream.tsx",
  "src/VirtualCommitList.tsx",
  "src/publishedRepository.ts",
], 3);
const docsRoute = await directRouteStats([
  "index.html",
  "src/NanocodexApp.tsx",
  "src/Docs.tsx",
], 1, [docsSyntaxKey, docsOverviewLanguageKey]);
const changelogRoute = await directRouteStats([
  "index.html",
  "src/NanocodexApp.tsx",
  "src/Changelog.tsx",
], 4);
const evalsRoute = await directRouteStats([
  "index.html",
  "src/NanocodexApp.tsx",
  "src/Evals.tsx",
], 2);
const signedOutStatic = new Set([
  ...initialStatic,
  ...applicationStatic,
  ...homeFrameStatic,
  ...experienceStatic,
]);
assert(
  !initialStatic.has(agentKey),
  "the initial route must not statically import the Agent terminal",
);
assert(
  !experienceStatic.has(agentKey),
  "the signed-out credential experience must not statically import the Agent terminal",
);
assert(
  importClosure(experienceKey, true).has(agentKey),
  "the authenticated credential path must dynamically reach the Agent terminal",
);
assert(
  importClosure(experienceKey, true).has(agentRuntimeKey),
  "the authenticated credential path must independently reach the Agent runtime",
);
assert(
  !importClosure(manifestKey("src/Docs.tsx"), false).has(docsSyntaxKey),
  "documentation syntax must load only while preparing a concrete page",
);
for (const language of ["javascript", "python", "rust", "tsx"]) {
  const key = exactlyOne(
    Object.keys(manifest).filter((candidate) =>
      manifest[candidate]?.name === language
      && (candidate.includes("node_modules/@shikijs/langs/") || candidate.startsWith(`_${language}-`))
    ),
    `lazy documentation ${language} grammar`,
  );
  assert(
    !docsRoute.staticChunks.has(key),
    `the documentation overview must not load its unused ${language} grammar`,
  );
}
assert(
  agentStatic.has(agentRuntimeKey) && !agentRuntimeStatic.has(agentKey),
  "the terminal must consume the shared Agent runtime without entering its prewarm graph",
);
const initialJavaScript = await closureStats(initialStatic, "file");
const signedOutJavaScript = await closureStats(signedOutStatic, "file");
const initialCssFiles = cssClosure(initialStatic);
const initialCss = await fileStats(initialCssFiles);
const agentJavaScript = await closureStats(agentStatic, "file");
const agentRuntimeJavaScript = await closureStats(agentRuntimeStatic, "file");
const signedOutSource = await closureSource(signedOutStatic);
const agentSource = await closureSource(agentStatic);
const agentRuntimeSource = await closureSource(agentRuntimeStatic);
const workerAgentMarker = "nanocodex.worker-agent.v1";
assert(
  !signedOutSource.includes(workerAgentMarker),
  "the signed-out credential experience must not include the WorkerAgent wrapper",
);
assert(
  agentSource.includes(workerAgentMarker),
  "the authenticated Agent terminal must include the WorkerAgent wrapper",
);
assert(
  agentRuntimeSource.includes(workerAgentMarker),
  "the independent prewarm graph must include the WorkerAgent wrapper",
);
assert(
  !signedOutSource.includes("Nanocodex terminal input")
    && !signedOutSource.includes("xterm-accessibility"),
  "the signed-out credential experience must not include xterm",
);
assert(
  agentSource.includes("Nanocodex terminal input")
    && agentSource.includes("xterm-accessibility"),
  "the authenticated Agent terminal must include xterm",
);
assert(
  !agentRuntimeSource.includes("Nanocodex terminal input")
    && !agentRuntimeSource.includes("xterm-accessibility"),
  "terminal presentation must stay out of the Worker/WASM prewarm graph",
);

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
withinCount(
  "signed-out JavaScript chunks",
  signedOutJavaScript.fileCount,
  budgets.signedOutJavaScriptFiles,
);
within(
  "signed-out JavaScript",
  signedOutJavaScript.bytes,
  budgets.signedOutJavaScript,
);
within(
  "signed-out JavaScript gzip",
  signedOutJavaScript.gzipBytes,
  budgets.signedOutJavaScriptGzip,
);
withinRoute("Source", sourceRoute, {
  requests: budgets.sourceRouteRequests,
  javascriptGzip: budgets.sourceRouteJavaScriptGzip,
  cssGzip: budgets.sourceRouteCssGzip,
});
withinRoute("Commits", commitsRoute, {
  requests: budgets.commitsRouteRequests,
  javascriptGzip: budgets.commitsRouteJavaScriptGzip,
  cssGzip: budgets.commitsRouteCssGzip,
});
withinRoute("Docs", docsRoute, {
  requests: budgets.docsRouteRequests,
  javascriptGzip: budgets.docsRouteJavaScriptGzip,
  cssGzip: budgets.docsRouteCssGzip,
});
withinRoute("Changelog", changelogRoute, {
  requests: budgets.changelogRouteRequests,
  javascriptGzip: budgets.changelogRouteJavaScriptGzip,
  cssGzip: budgets.changelogRouteCssGzip,
});
withinRoute("Evals", evalsRoute, {
  requests: budgets.evalsRouteRequests,
  javascriptGzip: budgets.evalsRouteJavaScriptGzip,
  cssGzip: budgets.evalsRouteCssGzip,
});
within("Agent JavaScript", agentJavaScript.bytes, budgets.agentJavaScript);
withinCount(
  "Agent runtime JavaScript chunks",
  agentRuntimeJavaScript.fileCount,
  budgets.agentRuntimeJavaScriptFiles,
);
within(
  "Agent runtime JavaScript",
  agentRuntimeJavaScript.bytes,
  budgets.agentRuntimeJavaScript,
);
within(
  "Agent runtime JavaScript gzip",
  agentRuntimeJavaScript.gzipBytes,
  budgets.agentRuntimeJavaScriptGzip,
);

const html = await readFile(join(clientDirectory, "index.html"), "utf8");
const headers = await readFile(join(clientDirectory, "_headers"), "utf8");
const assetsIgnore = await readFile(join(clientDirectory, ".assetsignore"), "utf8");
assert.match(
  assetsIgnore,
  /^\.vite\/$/m,
  "build-only Vite metadata must stay out of deployed assets",
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
assert(
  !signedOutSource.includes(workerFile),
  "the signed-out credential experience must not reference the Agent Worker",
);
assert(
  agentSource.includes(workerFile),
  "the authenticated Agent terminal must reference the Agent Worker",
);
const workerFiles = await staticAssetClosure(workerFile);
const workerSource = await assetSource(workerFiles);
const worker = await fileStats(
  [...workerFiles].map((file) => `assets/${file}`),
);
within("OpenAI Agent Worker", worker.bytes, budgets.agentWorker);
within(
  "OpenAI Agent Worker gzip",
  worker.gzipBytes,
  budgets.agentWorkerGzip,
);

const browserShellFile = await findLazyAsset(
  workerSource,
  (_file, source) => source.includes("persistent browser filesystem rooted at /workspace"),
);
assert(browserShellFile, "the Agent Worker must lazy-load the browser shell");
const browserShellSource = await readFile(join(assetsDirectory, browserShellFile), "utf8");
const browserShellFiles = await staticAssetClosure(browserShellFile);
const browserShellClosureSource = await assetSource(browserShellFiles);
for (const forbidden of [
  "__vite-browser-external",
  "node:zlib",
  "from\"sprintf-js\"",
  "from'sprintf-js'",
]) {
  assert(
    !browserShellClosureSource.includes(forbidden),
    `the served browser shell graph contains unresolved compatibility marker ${forbidden}`,
  );
}
const browserShell = await fileStats(
  [...browserShellFiles].map((file) => `assets/${file}`),
);
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

const browserBashFile = await findLazyAsset(
  browserShellSource,
  (_file, source) => source.includes("bug in just-bash"),
);
assert(browserBashFile, "the browser shell must lazy-load Bash on first exec_command");
assert(
  !browserShellFiles.has(browserBashFile),
  "the Bash interpreter must not enter authenticated Agent startup",
);
assert(!html.includes(browserBashFile), "index.html must not preload the Bash interpreter");
const browserBash = await fileStats([`assets/${browserBashFile}`]);
within("Browser Bash JavaScript", browserBash.bytes, budgets.browserBashJavaScript);
within(
  "Browser Bash JavaScript gzip",
  browserBash.gzipBytes,
  budgets.browserBashJavaScriptGzip,
);

const pythonFile = await findLazyAsset(
  browserShellSource,
  (_file, source) => source.includes("Python worker failed"),
);
const compilerFile = await findLazyAsset(
  browserShellSource,
  (_file, source) => source.includes("compiler worker failed"),
);
const sshFile = await findLazyAsset(
  browserShellSource,
  (_file, source) => source.includes("Browser SSH requires a server-provided WebSocket"),
);
assert(pythonFile, "the browser shell must lazy-load Python on first use");
assert(compilerFile, "the browser shell must lazy-load wasm-clang on first use");
assert(sshFile, "the browser shell must lazy-load SSH on first use");
for (const file of [pythonFile, compilerFile, sshFile]) {
  assert(
    !browserShellFiles.has(file),
    `${file} must not enter the browser shell's static closure`,
  );
}

const pythonWorkerFile = exactlyOne(
  assets.filter((file) => /^python\.worker-.*\.js$/.test(file)),
  "lazy Python Worker",
);
const compilerWorkerFile = exactlyOne(
  assets.filter((file) => /^compiler\.worker-.*\.js$/.test(file)),
  "lazy compiler Worker",
);
const pythonSource = await readFile(join(assetsDirectory, pythonFile), "utf8");
const compilerSource = await readFile(join(assetsDirectory, compilerFile), "utf8");
assert(
  pythonSource.includes(pythonWorkerFile),
  "the Python command must create its isolated Worker only on execution",
);
assert(
  compilerSource.includes(compilerWorkerFile),
  "the compiler command must create its isolated Worker only on execution",
);

const datasetFacadeFile = await findLazyAsset(
  workerSource,
  (_file, source) => source.includes("dataset tool options must be an object"),
);
assert(datasetFacadeFile, "the package-owned browser tools must lazy-load the dataset facade");
assert(!html.includes(datasetFacadeFile), "index.html must not preload the dataset facade");
assert(
  !browserShellFiles.has(datasetFacadeFile),
  "the dataset facade must not enter the browser shell's static closure",
);
const datasetFacadeSource = await readFile(join(assetsDirectory, datasetFacadeFile), "utf8");
const datasetFacade = byteStats(datasetFacadeSource);
within("Dataset facade JavaScript", datasetFacade.bytes, budgets.datasetFacadeJavaScript);
within(
  "Dataset facade JavaScript gzip",
  datasetFacade.gzipBytes,
  budgets.datasetFacadeJavaScriptGzip,
);
assert(
  datasetFacadeSource.includes("when complete is false")
    && datasetFacadeSource.includes("max_bytes"),
  "the dataset facade must statically own its model-visible contract",
);
const datasetImport = datasetFacadeSource.match(
  /import\((?:`|'|")\.\/(datasetEngine-[^`'"]+\.js)(?:`|'|")\)/,
);
assert(datasetImport, "the dataset facade must retain an explicit lazy engine edge");
const datasetFile = datasetImport[1];
assert(assets.includes(datasetFile), `the lazy dataset tool ${datasetFile} is missing`);
assert(!html.includes(datasetFile), "index.html must not preload the dataset tool");
const datasetPath = join(assetsDirectory, datasetFile);
const datasetSource = await readFile(datasetPath, "utf8");
const dataset = byteStats(datasetSource);
within("Dataset tool JavaScript", dataset.bytes, budgets.datasetToolJavaScript);
within(
  "Dataset tool JavaScript gzip",
  dataset.gzipBytes,
  budgets.datasetToolJavaScriptGzip,
);
const datasetRuntimeImports = [...datasetSource.matchAll(
  /import\((?:`|'|")\.\/(src-[^`'"]+\.js)(?:`|'|")\)/g,
)].map((match) => match[1]);
assert.equal(datasetRuntimeImports.length, 2, "the dataset tool must lazily load Parquet and its codecs");
for (const file of datasetRuntimeImports) {
  assert(assets.includes(file), `the lazy dataset runtime ${file} is missing`);
  assert(!html.includes(file), `index.html must not preload the dataset runtime ${file}`);
}
const datasetRuntimeSources = await Promise.all(datasetRuntimeImports.map(async (file) => ({
  file,
  source: await readFile(join(assetsDirectory, file), "utf8"),
})));
const parquetFile = exactlyOne(
  datasetRuntimeSources
    .filter(({ source }) => source.includes("parquet expected AsyncBuffer"))
    .map(({ file }) => file),
  "Hyparquet runtime",
);
const parquetCompressorsFile = exactlyOne(
  datasetRuntimeSources
    .filter(({ source }) => source.includes("lz4 offset out of range"))
    .map(({ file }) => file),
  "Parquet compressor runtime",
);
const parquet = await fileStats([`assets/${parquetFile}`]);
within("Hyparquet JavaScript", parquet.bytes, budgets.parquetJavaScript);
within("Hyparquet JavaScript gzip", parquet.gzipBytes, budgets.parquetJavaScriptGzip);
const parquetCompressors = await fileStats([`assets/${parquetCompressorsFile}`]);
within(
  "Parquet compressors JavaScript",
  parquetCompressors.bytes,
  budgets.parquetCompressorsJavaScript,
);
within(
  "Parquet compressors JavaScript gzip",
  parquetCompressors.gzipBytes,
  budgets.parquetCompressorsJavaScriptGzip,
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
const workerReachableFiles = await reachableAssetClosure(workerFile);
const workerReachableSource = await assetSource(workerReachableFiles);
assert(
  !signedOutSource.includes(wasmFile),
  "the signed-out credential experience must not reference Nanocodex WASM",
);
assert(
  workerReachableSource.includes(wasmFile),
  "the authenticated Agent Worker must reach Nanocodex WASM",
);
const missingWasmImports = wasmImports.filter((entry) =>
  entry.module !== "./nanocodex_bg.js"
  || entry.kind !== "function"
  || !workerReachableSource.includes(entry.name)
);
assert.deepEqual(
  missingWasmImports,
  [],
  "the Agent Worker wasm-bindgen glue does not satisfy the bundled WASM imports",
);
const wasm = await fileStats([`assets/${wasmFile}`]);
within("Nanocodex WASM", wasm.bytes, budgets.wasm);
within("Nanocodex WASM gzip", wasm.gzipBytes, budgets.wasmGzip);

const workerManifest = JSON.parse(
  await readFile(join(workerDirectory, ".vite", "manifest.json"), "utf8"),
);
const subscriptionRuntimeKey = exactlyOne(
  Object.entries(workerManifest).filter(([key, entry]) =>
    key.endsWith("worker/subscriptionRuntime.ts")
    && entry.name === "subscriptionRuntime"
    && entry.isDynamicEntry === true
  ).map(([key]) => key),
  "Cloudflare subscription runtime entry",
);
const subscriptionRuntime = workerManifest[subscriptionRuntimeKey];
const subscriptionRuntimeSource = await readFile(
  join(workerDirectory, subscriptionRuntime.file),
  "utf8",
);
const workerAssets = await readdir(join(workerDirectory, "assets"));
const workerWasmFile = exactlyOne(
  workerAssets.filter((file) => /^nanocodex_bg-.*\.wasm$/.test(file)),
  "Cloudflare subscription WASM module",
);
assert(
  subscriptionRuntimeSource.includes(`./${workerWasmFile}`),
  "the subscription runtime must import its compiled WASM module",
);
assert.match(
  subscriptionRuntimeSource,
  /module:\s*wasmModule/,
  "the subscription runtime must pass its compiled module to the host-generic API",
);
assert.match(
  subscriptionRuntimeSource,
  /module_or_path:\s*module/,
  "the subscription runtime must instantiate its compiled module through wasm-bindgen",
);

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
  signedOut: {
    javascriptFiles: signedOutJavaScript.fileCount,
    javascriptBytes: signedOutJavaScript.bytes,
    javascriptGzipBytes: signedOutJavaScript.gzipBytes,
    staticChunks: [...signedOutStatic],
  },
  signedOutRoutes: {
    source: routeReport(sourceRoute),
    commits: routeReport(commitsRoute),
    docs: routeReport(docsRoute),
    changelog: routeReport(changelogRoute),
    evals: routeReport(evalsRoute),
  },
  agent: {
    javascriptBytes: agentJavaScript.bytes,
    runtimeFiles: agentRuntimeJavaScript.fileCount,
    runtimeBytes: agentRuntimeJavaScript.bytes,
    runtimeGzipBytes: agentRuntimeJavaScript.gzipBytes,
    workerFiles: worker.fileCount,
    workerBytes: worker.bytes,
    workerGzipBytes: worker.gzipBytes,
  },
  browserTools: {
    shellFiles: browserShell.fileCount,
    shellBytes: browserShell.bytes,
    shellGzipBytes: browserShell.gzipBytes,
    bashBytes: browserBash.bytes,
    bashGzipBytes: browserBash.gzipBytes,
    pythonEntry: pythonFile,
    compilerEntry: compilerFile,
    sshEntry: sshFile,
    dataset: {
      facadeBytes: datasetFacade.bytes,
      facadeGzipBytes: datasetFacade.gzipBytes,
      toolBytes: dataset.bytes,
      toolGzipBytes: dataset.gzipBytes,
      parquetBytes: parquet.bytes,
      parquetGzipBytes: parquet.gzipBytes,
      compressorsBytes: parquetCompressors.bytes,
      compressorsGzipBytes: parquetCompressors.gzipBytes,
    },
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

async function directRouteStats(rootSuffixes, dataRequests, additionalRoots = []) {
  const staticChunks = new Set();
  const roots = [...rootSuffixes.map(manifestKey), ...additionalRoots];
  for (const root of roots) {
    for (const key of importClosure(root, false)) {
      staticChunks.add(key);
    }
  }
  const javascript = await closureStats(staticChunks, "file");
  const css = await fileStats(cssClosure(staticChunks));
  return {
    css,
    dataRequests,
    javascript,
    requestCount: 1 + javascript.fileCount + css.fileCount + dataRequests,
    staticChunks,
  };
}

function routeReport(route) {
  return {
    requests: route.requestCount,
    dataRequests: route.dataRequests,
    javascriptFiles: route.javascript.fileCount,
    javascriptGzipBytes: route.javascript.gzipBytes,
    cssFiles: route.css.fileCount,
    cssGzipBytes: route.css.gzipBytes,
    staticChunks: [...route.staticChunks],
  };
}

function withinRoute(name, route, budget) {
  withinCount(`signed-out ${name} route requests`, route.requestCount, budget.requests);
  within(
    `signed-out ${name} route JavaScript gzip`,
    route.javascript.gzipBytes,
    budget.javascriptGzip,
  );
  within(`signed-out ${name} route CSS gzip`, route.css.gzipBytes, budget.cssGzip);
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

async function assetSource(files) {
  const sources = await Promise.all(
    [...files].map((file) => readFile(join(assetsDirectory, file))),
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

async function findLazyAsset(source, matches, visited = new Set()) {
  const imports = [...source.matchAll(
    /import\((?:`|'|")\.\/([^`'"]+\.js)(?:`|'|")\)/g,
  )].map((match) => match[1]);
  for (const file of imports) {
    if (visited.has(file)) continue;
    visited.add(file);
    const child = await readFile(join(assetsDirectory, file), "utf8");
    if (matches(file, child)) return file;
    const found = await findLazyAsset(child, matches, visited);
    if (found) return found;
  }
  return undefined;
}

async function assetClosure(root, includeDynamic, visited) {
  if (visited.has(root)) return visited;
  visited.add(root);
  const source = await readFile(join(assetsDirectory, root), "utf8");
  const imports = new Set([
    ...source.matchAll(
      /(?:import|export)[^"'`()]*?from(?:`|'|")\.\/([^`'"]+\.js)(?:`|'|")/g,
    ),
    ...source.matchAll(
      /import(?:`|'|")\.\/([^`'"]+\.js)(?:`|'|")/g,
    ),
  ].map((match) => match[1]));
  if (includeDynamic) {
    for (const match of source.matchAll(
      /import\((?:`|'|")\.\/([^`'"]+\.js)(?:`|'|")\)/g,
    )) imports.add(match[1]);
  }
  for (const file of imports) await assetClosure(file, includeDynamic, visited);
  return visited;
}

async function staticAssetClosure(root, visited = new Set()) {
  return assetClosure(root, false, visited);
}

async function reachableAssetClosure(root, visited = new Set()) {
  return assetClosure(root, true, visited);
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
