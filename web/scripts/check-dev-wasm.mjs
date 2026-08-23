import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageDirectory = new URL("../../js/bindings/pkg-web/", import.meta.url);
const webRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(webRoot, "..");
const bindingsRoot = resolve(repositoryRoot, "js/bindings");
export const requiredWasmFiles = [
  ".nanocodex-bindgen-stamp",
  "nanocodex.js",
  "nanocodex.d.ts",
  "nanocodex_bg.js",
  "nanocodex_bg.wasm",
  "nanocodex_bg.wasm.d.ts",
  "nanocodex_worker.js",
  "package.json",
];

export async function prepareDevWasm({
  bindingsDirectory = bindingsRoot,
  execute = run,
  inspect = missingWasmFiles,
  invalidate = invalidateBindgenStamp,
  isExecutable = isExecutableFile,
  packageUrl = packageDirectory,
  repositoryDirectory = repositoryRoot,
} = {}) {
  const initialProblems = await inspect(packageUrl);
  if (initialProblems.length > 0) {
    process.stderr.write(
      `Repairing the browser WASM package (${initialProblems.join(", ")}).\n`,
    );
    // The canonical builder's fingerprint fast path predates the complete
    // browser-package check below. Removing only its generated stamp forces it
    // to repair a malformed or partial package without duplicating generation.
    await invalidate(packageUrl);
  }

  const binaryen = resolve(bindingsDirectory, "node_modules/.bin/wasm-opt");
  if (!await isExecutable(binaryen)) {
    await execute("npm", ["ci", "--prefix", bindingsDirectory], repositoryDirectory);
    if (!await isExecutable(binaryen)) {
      throw new Error("npm ci did not install an executable wasm-opt");
    }
  }

  // Cargo owns source/build-script/cfg freshness. The canonical builder then
  // compares its exact source/tool output fingerprint with the bindgen stamp.
  // An incremental Cargo no-op is the only trustworthy cheap current check.
  await execute("just", ["build-wasm"], repositoryDirectory);

  const remainingProblems = await inspect(packageUrl);
  if (remainingProblems.length > 0) {
    throw new Error(
      `browser WASM preparation remained incomplete: ${remainingProblems.join(", ")}`,
    );
  }
}

export async function missingWasmFiles(directory = packageDirectory) {
  const missing = [];
  for (const file of requiredWasmFiles) {
    if (!await isNonemptyFile(new URL(file, directory))) missing.push(file);
  }
  const wasmUrl = new URL("nanocodex_bg.wasm", directory);
  if (await isNonemptyFile(wasmUrl)) {
    const wasm = await readFile(wasmUrl);
    const hasWasmHeader =
      wasm.length > 100_000
      && wasm[0] === 0x00
      && wasm[1] === 0x61
      && wasm[2] === 0x73
      && wasm[3] === 0x6d;
    if (!hasWasmHeader) missing.push("nanocodex_bg.wasm (invalid)");
  }
  return missing;
}

async function isNonemptyFile(path) {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function isExecutableFile(path) {
  if (!await isNonemptyFile(path)) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "ENOENT") return false;
    throw error;
  }
}

async function invalidateBindgenStamp(directory) {
  try {
    await unlink(new URL(".nanocodex-bindgen-stamp", directory));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function run(command, arguments_, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  await prepareDevWasm();
}
