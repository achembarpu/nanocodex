import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtifactStore,
  artifactPath,
  createArtifactTool,
  parseArtifactDocument,
  validateArtifactSpec,
  type ArtifactDocument,
} from "../src/index.ts";

test("persists and updates validated artifact documents", async () => {
  const workspace = memoryWorkspace();
  const emitted: ArtifactDocument[] = [];
  const tool = createArtifactTool(workspace, (artifact) => emitted.push(artifact));

  const created = await tool.handler({ id: "answer", title: "Answer dashboard", spec: dashboardSpec("42") });
  const updated = await tool.handler({ id: "answer", title: "Updated dashboard", spec: dashboardSpec("43") });

  assert.deepEqual(created, {
    artifactId: "answer",
    path: artifactPath("answer"),
    title: "Answer dashboard",
    elements: 3,
  });
  assert.equal(updated.artifactId, "answer");
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]?.createdAt, emitted[0]?.createdAt);
  assert.equal((await new ArtifactStore(workspace).list())[0]?.title, "Updated dashboard");
});

test("scans valid documents without hiding rejected paths", async () => {
  const workspace = memoryWorkspace();
  const store = new ArtifactStore(workspace);
  await store.save({ title: "Valid", spec: dashboardSpec("1") });
  await workspace.writeFile(artifactPath("broken"), "not json");

  const scan = await store.scan();
  assert.equal(scan.artifacts.length, 1);
  assert.equal(scan.rejected.length, 1);
  assert.equal(scan.rejected[0]?.path, artifactPath("broken"));
});

test("rejects documents whose identity does not match their storage path", async () => {
  const workspace = memoryWorkspace();
  const store = new ArtifactStore(workspace);
  const artifact = await store.save({ id: "source", title: "Source", spec: dashboardSpec("1") });
  await workspace.writeFile(artifactPath("alias"), JSON.stringify(artifact));

  const scan = await store.scan();
  assert.deepEqual(scan.artifacts.map(({ id }) => id), ["source"]);
  assert.equal(scan.rejected[0]?.path, artifactPath("alias"));
  assert.match(String(scan.rejected[0]?.error), /does not match its filename/);
});

test("derives persistence from the caller-owned workspace root", async () => {
  const workspace = memoryWorkspace("/kernel");
  const store = new ArtifactStore(workspace);
  const artifact = await store.save({ id: "rooted", title: "Rooted", spec: dashboardSpec("1") });

  assert.equal(store.directory, "/kernel/.nanocodex/artifacts");
  assert.equal((await workspace.readFile(`${store.directory}/${artifact.id}.json`)).byteLength > 0, true);
});

test("rejects unknown data, ambiguous trees, and unsafe values", () => {
  assert.throws(
    () => validateArtifactSpec({ root: "x", elements: { x: { type: "Script", props: {} } } }),
    /unsupported artifact component/,
  );
  assert.throws(
    () => validateArtifactSpec({ root: "x", elements: { x: { type: "Stack", props: {}, children: ["x"] } } }),
    /cycle|root cannot be a child/,
  );
  assert.throws(
    () => validateArtifactSpec({ root: "x", elements: { x: { type: "Stack", props: {}, children: ["y"] } } }),
    /missing element/,
  );
  assert.throws(
    () => validateArtifactSpec({
      root: "x",
      elements: {
        x: { type: "Text", props: { text: "visible" } },
        y: { type: "Text", props: { text: "orphaned" } },
      },
    }),
    /unreachable/,
  );
  assert.throws(
    () => validateArtifactSpec({
      root: "root",
      elements: {
        root: { type: "Grid", props: {}, children: ["left", "right"] },
        left: { type: "Card", props: {}, children: ["shared"] },
        right: { type: "Card", props: {}, children: ["shared"] },
        shared: { type: "Text", props: { text: "ambiguous" } },
      },
    }),
    /multiple parents/,
  );
  assert.throws(
    () => validateArtifactSpec({ root: "x", elements: { x: { type: "Text", props: { text: "x" }, children: ["y"] } } }),
    /cannot have children/,
  );
  assert.throws(
    () => validateArtifactSpec({ root: "x", elements: { x: { type: "Text", props: { text: "x", onclick: "evil" } } } }),
    /unsupported properties/,
  );
  assert.throws(
    () => validateArtifactSpec({
      root: "chart",
      elements: { chart: { type: "BarChart", props: { data: [{ label: "x", value: 1 }], color: "url(evil)" } } },
    }),
    /hex or named color/,
  );
  assert.throws(
    () => parseArtifactDocument(JSON.stringify({
      version: 1,
      id: "x",
      title: "x",
      spec: dashboardSpec("1"),
      createdAt: 1,
      updatedAt: 1,
      script: "evil",
    })),
    /unsupported properties/,
  );
  const columns = Array.from({ length: 12 }, (_, index) => ({ key: `c${index}`, label: `C${index}` }));
  const rows = Array.from({ length: 100 }, () => Object.fromEntries(columns.map(({ key }) => [key, "x"])));
  assert.throws(
    () => validateArtifactSpec({
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children: ["t1", "t2", "t3", "t4", "t5"] },
        ...Object.fromEntries([1, 2, 3, 4, 5].map((index) => [
          `t${index}`,
          { type: "Table", props: { columns, rows } },
        ])),
      },
    }),
    /render budget/,
  );
});

function dashboardSpec(value: string) {
  return {
    root: "root",
    elements: {
      root: { type: "Grid", props: { columns: 2 }, children: ["metric", "action"] },
      metric: { type: "Metric", props: { label: "Answer", value, trend: "up" } },
      action: { type: "Button", props: { label: "Explain", prompt: "Explain this answer" } },
    },
  };
}

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
