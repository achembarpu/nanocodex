import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactPath,
  createArtifactTool,
  loadArtifacts,
  validateArtifactSpec,
  type ArtifactDocument,
} from "../src/artifact.ts";

test("persists and updates validated artifact documents", async () => {
  const workspace = memoryWorkspace();
  const emitted: ArtifactDocument[] = [];
  const tool = createArtifactTool(workspace, (artifact) => emitted.push(artifact));
  const spec = dashboardSpec("42");

  const created = await tool.handler({ id: "answer", title: "Answer dashboard", spec });
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
  assert.equal((await loadArtifacts(workspace))[0]?.title, "Updated dashboard");
});

test("rejects unknown components, cycles, missing children, and unreachable elements", () => {
  assert.throws(
    () => validateArtifactSpec({ root: "x", elements: { x: { type: "Script", props: {} } } }),
    /unsupported artifact component/,
  );
  assert.throws(
    () => validateArtifactSpec({ root: "x", elements: { x: { type: "Stack", props: {}, children: ["x"] } } }),
    /cycle/,
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
      root: "tabs",
      elements: {
        tabs: { type: "Tabs", props: { labels: ["One", "Two"] }, children: ["one"] },
        one: { type: "Text", props: { text: "one" } },
      },
    }),
    /one label per child/,
  );
  assert.throws(
    () => validateArtifactSpec({
      root: "chart",
      elements: {
        chart: { type: "BarChart", props: { data: [{ label: "x", value: 1 }], color: "url(https://bad.test)" } },
      },
    }),
    /hex or named color/,
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

function memoryWorkspace() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(["/workspace"]);
  return {
    root: "/workspace",
    async list() {
      return [
        ...[...directories]
          .filter((path) => path !== "/workspace")
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
