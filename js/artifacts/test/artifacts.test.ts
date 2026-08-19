import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtifactStore,
  artifactPath,
  artifactToolDefinition,
  createArtifactTool,
  parseArtifactDocument,
  type ArtifactDocument,
} from "../src/index.ts";

const source = "function App() { return html`<h1>Live</h1>`; }";

test("persists and updates live React source documents", async () => {
  const workspace = memoryWorkspace();
  const emitted: ArtifactDocument[] = [];
  const tool = createArtifactTool(workspace, (artifact) => emitted.push(artifact));

  const created = await tool.handler({ id: "answer", title: "Answer UI", source });
  const updated = await tool.handler({
    id: "answer",
    title: "Updated UI",
    source: "function App() { return html`<h1>Updated</h1>`; }",
  });

  assert.deepEqual(created, {
    artifactId: "answer",
    path: artifactPath("answer"),
    title: "Answer UI",
    runtime: "react",
  });
  assert.equal(updated.artifactId, "answer");
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]?.createdAt, emitted[0]?.createdAt);
  assert.equal((await new ArtifactStore(workspace).list())[0]?.title, "Updated UI");
});

test("exposes only the custom React source tool contract", () => {
  assert.deepEqual(artifactToolDefinition.parameters.required, ["title", "source"]);
  assert.deepEqual(Object.keys(artifactToolDefinition.parameters.properties), ["id", "title", "source"]);
  assert.equal(artifactToolDefinition.description.includes("React"), true);
  assert.equal(artifactToolDefinition.description.includes("sendPrompt"), true);
});

test("scans valid source documents without hiding rejected legacy documents", async () => {
  const workspace = memoryWorkspace();
  const store = new ArtifactStore(workspace);
  await store.save({ title: "Valid", source });
  await workspace.writeFile(artifactPath("legacy"), JSON.stringify({
    version: 1,
    id: "legacy",
    title: "Legacy",
    spec: { root: "root", elements: {} },
    createdAt: 1,
    updatedAt: 1,
  }));

  const scan = await store.scan();
  assert.equal(scan.artifacts.length, 1);
  assert.equal(scan.rejected.length, 1);
  assert.equal(scan.rejected[0]?.path, artifactPath("legacy"));
});

test("a source artifact replaces an obsolete document with the same ID", async () => {
  const workspace = memoryWorkspace();
  const store = new ArtifactStore(workspace);
  await workspace.writeFile(artifactPath("artifact-demo"), JSON.stringify({
    version: 1,
    id: "artifact-demo",
    title: "Old demo",
    spec: { root: "root", elements: {} },
    createdAt: 1,
    updatedAt: 1,
  }));

  const artifact = await store.save({ id: "artifact-demo", title: "React demo", source });

  assert.equal(artifact.source, source);
  assert.equal((await store.read("artifact-demo")).title, "React demo");
  assert.deepEqual((await store.scan()).rejected, []);
});

test("rejects documents whose identity does not match their storage path", async () => {
  const workspace = memoryWorkspace();
  const store = new ArtifactStore(workspace);
  const artifact = await store.save({ id: "source", title: "Source", source });
  await workspace.writeFile(artifactPath("alias"), JSON.stringify(artifact));

  const scan = await store.scan();
  assert.deepEqual(scan.artifacts.map(({ id }) => id), ["source"]);
  assert.equal(scan.rejected[0]?.path, artifactPath("alias"));
  assert.match(String(scan.rejected[0]?.error), /does not match its filename/);
});

test("derives persistence from the caller-owned workspace root", async () => {
  const workspace = memoryWorkspace("/kernel");
  const store = new ArtifactStore(workspace);
  const artifact = await store.save({ id: "rooted", title: "Rooted", source });

  assert.equal(store.directory, "/kernel/.nanocodex/artifacts");
  assert.equal((await workspace.readFile(`${store.directory}/${artifact.id}.json`)).byteLength > 0, true);
});

test("rejects missing source, legacy specs, and unknown fields", async () => {
  const store = new ArtifactStore(memoryWorkspace());
  await assert.rejects(() => store.save({ title: "Missing" }), /source must be a string/);
  await assert.rejects(
    () => store.save({ title: "Legacy", spec: { root: "root", elements: {} } }),
    /unsupported properties: spec/,
  );
  assert.throws(
    () => parseArtifactDocument(JSON.stringify({
      version: 1,
      id: "x",
      title: "x",
      source,
      createdAt: 1,
      updatedAt: 1,
      script: "evil",
    })),
    /unsupported properties: script/,
  );
});

test("does not impose binding-specific document or source limits", async () => {
  const workspace = memoryWorkspace();
  const store = new ArtifactStore(workspace);
  const largeSource = `function App() { return ${JSON.stringify("x".repeat(600 * 1024))}; }`;
  const artifact = await store.save({ title: "Large", source: largeSource });
  assert.equal((await store.read(artifact.id)).source, largeSource);
});

function memoryWorkspace(root = "/workspace") {
  const files = new Map<string, Uint8Array>();
  const directories = new Set([root]);
  return {
    root,
    async list() {
      return [
        ...[...directories]
          .filter((path) => path !== root)
          .map((path) => ({ kind: "directory" as const, path })),
        ...[...files].map(([path, contents]) => ({ kind: "file" as const, path, size: contents.byteLength })),
      ];
    },
    async readFile(path: string) {
      const contents = files.get(path);
      if (!contents) throw new Error("not found");
      return contents;
    },
    async writeFile(path: string, contents: string | ArrayBuffer | ArrayBufferView) {
      files.set(path, typeof contents === "string"
        ? new TextEncoder().encode(contents)
        : contents instanceof ArrayBuffer
          ? new Uint8Array(contents)
          : new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength));
    },
    async remove(path: string) { files.delete(path); },
    async mkdir(path: string) { directories.add(path); },
  };
}
