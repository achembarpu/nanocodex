import { readFile, stat } from "node:fs/promises";

const packageDirectory = new URL("../../js/bindings/pkg-web/", import.meta.url);
const requiredFiles = [
  ".nanocodex-bindgen-stamp",
  "nanocodex.js",
  "nanocodex.d.ts",
  "nanocodex_bg.js",
  "nanocodex_bg.wasm",
  "nanocodex_bg.wasm.d.ts",
  "nanocodex_worker.js",
  "package.json",
];
const requiredDevelopmentFiles = [
  new URL("../../js/tui/dist/index.js", import.meta.url),
  new URL("../../js/tui/dist/index.d.ts", import.meta.url),
  new URL("../../js/tui-react/dist/index.js", import.meta.url),
  new URL("../../js/tui-react/dist/index.d.ts", import.meta.url),
];

const missingFiles = [];
for (const file of requiredFiles) {
  try {
    const metadata = await stat(new URL(file, packageDirectory));
    if (!metadata.isFile() || metadata.size === 0) missingFiles.push(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    missingFiles.push(file);
  }
}

for (const file of requiredDevelopmentFiles) {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size === 0) missingFiles.push(file.pathname);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    missingFiles.push(file.pathname);
  }
}

if (missingFiles.length === 0) {
  const wasm = await readFile(new URL("nanocodex_bg.wasm", packageDirectory));
  const hasWasmHeader =
    wasm.length > 100_000 &&
    wasm[0] === 0x00 &&
    wasm[1] === 0x61 &&
    wasm[2] === 0x73 &&
    wasm[3] === 0x6d;
  if (!hasWasmHeader) missingFiles.push("nanocodex_bg.wasm (invalid)");
}

if (missingFiles.length > 0) {
  console.error(
    [
      "Nanocodex's generated browser WASM package is missing or incomplete.",
      `Missing: ${missingFiles.join(", ")}`,
      "Run `npm run dev:wasm` once, then retry `npm run dev`.",
      "Run `npm run dev:packages` after changing the local TUI packages.",
      "For a new checkout, `npm run dev:bootstrap` prepares both boundaries.",
      "Run `npm run dev:rebuild` after Rust changes to rebuild and start in one command.",
    ].join("\n"),
  );
  process.exitCode = 1;
}
