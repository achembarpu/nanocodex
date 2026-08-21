import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
    // The package now owns the browser shell source while its language and SSH
    // dependencies remain external and runtime-lazy. npm's tar output differs
    // slightly across platforms, so retain a tight portable compressed gate.
    assert.ok(packed.size <= 2_500_000, `compressed package grew to ${packed.size} bytes`);
    // Both WASM targets include the canonical Rust apply_patch planner and the
    // full JSON-Schema-backed subagent runtime.
    assert.ok(
      packed.unpackedSize <= 8_050_000,
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
      import { createMemoryDurabilityStore, durabilityRevision } from "nanocodex/durability";
      import {
        createPostgresDurabilityStore,
        UnknownPostgresCommitOutcomeError,
      } from "nanocodex/durability/postgres";
      import { Agent as HostAgent, Transport as HostTransport } from "nanocodex/host";
      import { dataset as aggregateDataset, web } from "nanocodex/tools";
      import { dataset } from "nanocodex/tools/dataset";
      import { nanocodexTools } from "nanocodex/tools/vite";
      import { Agent as NodeAgent, Subagents as NodeSubagents, Transport as NodeTransport, Workspace as NodeWorkspace } from "nanocodex/node";
      import { Subagents as BrowserSubagents, Workspace as BrowserWorkspace } from "nanocodex/browser";

      assert.equal(typeof Actions.turn.prompt, "function");
      assert.equal(durabilityRevision(1n), "1");
      assert.equal(createMemoryDurabilityStore("package-journal").journalId, "package-journal");
      let postgresCalls = 0;
      const postgresStore = createPostgresDurabilityStore({
        connect() {
          postgresCalls += 1;
          throw new Error("package smoke must stay cold");
        },
        query() {
          postgresCalls += 1;
          throw new Error("package smoke must stay cold");
        },
      });
      assert.equal(Object.isFrozen(postgresStore), true);
      assert.equal(postgresCalls, 0);
      const commitCause = new Error("connection closed");
      const commitError = new UnknownPostgresCommitOutcomeError("package-journal", commitCause);
      assert.equal(commitError.name, "UnknownPostgresCommitOutcomeError");
      assert.equal(commitError.cause, commitCause);
      assert.equal(typeof NodeWorkspace.open, "function");
      assert.equal(typeof BrowserWorkspace.open, "function");
      assert.equal(web({ url: "https://example.test/tools/web" }).name, "web__run");
      assert.equal(aggregateDataset().name, "dataset");
      const datasetTool = dataset({
        fetch: async () => new Response('{"id":1}\\n'),
      });
      assert(Object.isFrozen(datasetTool));
      const opened = await datasetTool.handler({
        operation: "open",
        source: { kind: "url", url: "https://example.test/data.jsonl", format: "jsonl" },
      }, {
        callId: "dataset-open",
        parentCallId: "",
        sessionId: "package-test",
        signal: new AbortController().signal,
      });
      assert.deepEqual(opened.previewRows, [{ id: 1 }]);
      assert.match(nanocodexTools().resolveId("node-rsa"), /unsupportedNodeRsa\.mjs$/);
      assert.match(nanocodexTools().resolveId("node:zlib"), /browserZlib\.mjs$/);
      const sprintfCompatibility = nanocodexTools().resolveId("sprintf-js", "/consumer.js");
      assert.match(sprintfCompatibility, /browserSprintf\.mjs$/);
      assert.equal(nanocodexTools().resolveId("sprintf-js", sprintfCompatibility), null);
      const [{ gzipSync, gunzipSync }, { sprintf }] = await Promise.all([
        import(sprintfCompatibility.replace(/browserSprintf\.mjs$/, "browserZlib.mjs")),
        import(sprintfCompatibility),
      ]);
      assert.equal(new TextDecoder().decode(gunzipSync(gzipSync("package gzip"))), "package gzip");
      assert.equal(sprintf("package %s", "printf"), "package printf");
      const nodeAgent = await NodeAgent.create({
        transport: NodeTransport.openAi({ apiKey: "package-test" }),
        tools: [...NodeSubagents.create({ maxConcurrency: 2 })],
      });
      assert.equal(nodeAgent.type, "node");
      await nodeAgent.session.shutdown();
      await nodeAgent.session.shutdown();

      const browserEntry = fileURLToPath(import.meta.resolve("nanocodex/browser"));
      const wasm = await readFile(resolve(
        dirname(browserEntry),
        "../pkg-web/nanocodex_bg.wasm",
      ));
      const browserAgent = await HostAgent.create({
        transport: HostTransport.openAi({
          apiKey: "package-test",
          WebSocketImpl: class {},
        }),
        module: wasm,
        tools: [...BrowserSubagents.create({ maxConcurrency: 2 })],
      });
      assert.equal(browserAgent.type, "browser");
      await browserAgent.session.shutdown();

      await assert.rejects(
        import("nanocodex/internal.mjs"),
        (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
      );
      await assert.rejects(
        import("nanocodex/tools/datasetEngine"),
        (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
      );
    `);
    await exec(process.execPath, [join(temporary, "package-smoke.mjs")], {
      cwd: temporary,
    });
    await writeFile(join(temporary, "package-smoke.mts"), `
      import type { DurabilityStore } from "nanocodex/durability";
      import {
        createPostgresDurabilityStore,
        type PostgresDurabilityClient,
        type PostgresDurabilityPool,
        type PostgresDurabilityQueryResult,
        UnknownPostgresCommitOutcomeError,
      } from "nanocodex/durability/postgres";

      declare const pool: PostgresDurabilityPool;
      const store: DurabilityStore = createPostgresDurabilityStore(pool);
      async function query(client: PostgresDurabilityClient) {
        const result: PostgresDurabilityQueryResult<{ revision: string }> =
          await client.query<{ revision: string }>("SELECT revision::text AS revision");
        client.release(true);
        return result.rows[0]?.revision;
      }
      const error = new UnknownPostgresCommitOutcomeError("typed-journal", new Error("closed"));
      void store;
      void query;
      void error;
    `);
    await exec(process.execPath, [
      fileURLToPath(new URL("node_modules/typescript/bin/tsc", packageRoot)),
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM,DOM.Iterable",
      join(temporary, "package-smoke.mts"),
    ], { cwd: temporary });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
