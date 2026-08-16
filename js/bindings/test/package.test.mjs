import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { checkDocumentedBrowserVersion } from "../scripts/check-package.mjs";

const exec = promisify(execFile);
const packageRoot = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
const readme = await readFile(new URL("README.md", packageRoot), "utf8");

test("the package checker permits immutable previews without rewriting release docs", () => {
  checkDocumentedBrowserVersion(readme, "0.0.0-preview-70ffd6b");
  assert.throws(
    () => checkDocumentedBrowserVersion(readme, "0.2.1"),
    /Expected values to be strictly equal/,
  );
});

test("the packed package installs and runs every public entry point", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "nanocodex-package-"));
  try {
    const { stdout } = await exec("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporary,
      new URL(".", packageRoot).pathname,
    ]);
    const [packed] = JSON.parse(stdout);
    assert.equal(packed.name, packageJson.name);
    assert.equal(packed.version, packageJson.version);
    assert.ok(packed.size <= 1_100_000, `compressed package grew to ${packed.size} bytes`);
    assert.ok(
      packed.unpackedSize <= 5_000_000,
      `unpacked package grew to ${packed.unpackedSize} bytes`,
    );
    assert.equal(
      packed.files.some(({ path }) => path.startsWith("scripts/")),
      false,
      "development-only package checks must not ship",
    );

    await exec("npm", ["init", "--yes"], { cwd: temporary });
    await exec("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(temporary, packed.filename),
    ], { cwd: temporary });
    await writeFile(join(temporary, "package-smoke.mjs"), `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      import { dirname, resolve } from "node:path";
      import { fileURLToPath } from "node:url";
      import { Actions } from "nanocodex";
      import { Agent as NodeAgent } from "nanocodex/node";
      import { Agent as BrowserAgent } from "nanocodex/browser";

      assert.equal(typeof Actions.turn.prompt, "function");
      const nodeAgent = await NodeAgent.create({ apiKey: "package-test" });
      assert.equal(nodeAgent.type, "node");
      await nodeAgent.session.shutdown();
      await nodeAgent.session.shutdown();

      const browserEntry = fileURLToPath(import.meta.resolve("nanocodex/browser"));
      const wasm = await readFile(resolve(
        dirname(browserEntry),
        "../pkg-web/nanocodex_bg.wasm",
      ));
      const browserAgent = await BrowserAgent.create({
        apiKey: "package-test",
        module: wasm,
        WebSocketImpl: class {},
      });
      assert.equal(browserAgent.type, "browser");
      await browserAgent.session.shutdown();

      await assert.rejects(
        import("nanocodex/internal.mjs"),
        (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
      );
    `);
    await exec(process.execPath, [join(temporary, "package-smoke.mjs")], {
      cwd: temporary,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
