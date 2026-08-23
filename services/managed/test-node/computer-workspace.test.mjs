import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import ts from "typescript";

const { createComputerFilesystem } = await loadAdapter();

test("adapts durable Computer files without allowing paths outside /workspace", async () => {
  const client = memoryComputer({
    files: {
      "/workspace/raw.bin": new Uint8Array([0, 1, 2]),
      "/workspace/notes/todo.md": "todo",
    },
  });
  const filesystem = await createComputerFilesystem(client);

  assert.equal(filesystem.root, "/workspace");
  assert.deepEqual(await filesystem.list(".", { recursive: true, maxEntries: 8 }), [
    { kind: "directory", modifiedAt: 7, path: "/workspace/notes" },
    { kind: "file", modifiedAt: 7, path: "/workspace/notes/todo.md", size: 4 },
    { kind: "file", modifiedAt: 7, path: "/workspace/raw.bin", size: 3 },
  ]);
  assert.deepEqual([...await filesystem.readFile("raw.bin")], [0, 1, 2]);
  await filesystem.writeFile("/workspace/generated/out.bin", new Uint8Array([4, 5]));
  assert.deepEqual([...await filesystem.readFile("generated/out.bin")], [4, 5]);
  await filesystem.mkdir("generated/subdir");
  await filesystem.remove("generated", { recursive: true });

  await assert.rejects(filesystem.list("/outside"), /stay within \/workspace/);
  await assert.rejects(filesystem.readFile("../secret"), /stay within \/workspace/);
  await assert.rejects(filesystem.writeFile("/tmp/file", "no"), /stay within \/workspace/);
  await assert.rejects(filesystem.mkdir("nested/../../escape"), /stay within \/workspace/);
  await assert.rejects(filesystem.remove("/workspace"), /cannot remove the workspace root/);
});

test("rejects every pre-existing symbolic-link traversal", async () => {
  const client = memoryComputer({
    files: { "/workspace/plain.txt": "safe" },
    symlinks: ["/workspace/link"],
  });
  const filesystem = await createComputerFilesystem(client);

  await assert.rejects(filesystem.list("."), /symbolic links are not supported/);
  await assert.rejects(filesystem.readFile("link/secret"), /symbolic links are not supported/);
  await assert.rejects(filesystem.writeFile("link/new.txt", "no"), /symbolic links are not supported/);
  await assert.rejects(filesystem.remove("link"), /symbolic links are not supported/);
  assert.equal(client.inspect.readCount, 0);
  assert.equal(client.inspect.writeCount, 0);
  assert.equal(client.inspect.removeCount, 0);
});

test("bounds file reads and writes before allocating or touching Computer storage", async () => {
  const client = memoryComputer({ files: { "/workspace/large.bin": "12345" } });
  const filesystem = await createComputerFilesystem(client, { maxFileBytes: 4 });

  await assert.rejects(filesystem.readFile("large.bin"), /4-byte read bound/);
  await assert.rejects(filesystem.writeFile("new.bin", "12345"), /4-byte write bound/);
  assert.equal(client.inspect.readCount, 0);
  assert.equal(client.inspect.writeCount, 0);
});

test("fails a read if the file grows after lstat", async () => {
  const client = memoryComputer({ files: { "/workspace/racy.bin": "four" } });
  const lstat = client.fs.lstat;
  client.fs.lstat = async (path) => {
    const stat = await lstat(path);
    return path === "/workspace/racy.bin" ? { ...stat, size: 3 } : stat;
  };
  const filesystem = await createComputerFilesystem(client, { maxFileBytes: 8 });

  await assert.rejects(filesystem.readFile("racy.bin"), /changed or exceeds/);
});

test("enforces recursive listing limits", async () => {
  const client = memoryComputer({
    files: {
      "/workspace/a.txt": "a",
      "/workspace/b.txt": "b",
      "/workspace/c.txt": "c",
    },
  });
  const filesystem = await createComputerFilesystem(client);
  await assert.rejects(
    filesystem.list(".", { recursive: true, maxEntries: 2 }),
    /listing exceeds 2 entries/,
  );
});

function memoryComputer({ files = {}, symlinks = [] } = {}) {
  const storedFiles = new Map(
    Object.entries(files).map(([path, contents]) => [path, toBytes(contents)]),
  );
  const storedSymlinks = new Set(symlinks);
  const directories = new Set();
  for (const path of [...storedFiles.keys(), ...storedSymlinks]) addParents(directories, path);
  const inspect = { readCount: 0, writeCount: 0, removeCount: 0 };

  return {
    inspect,
    fs: {
      async lstat(path) {
        if (storedSymlinks.has(path)) return stat("symlink", 0);
        if (storedFiles.has(path)) return stat("file", storedFiles.get(path).byteLength);
        if (directories.has(path)) return stat("directory", 0);
        throw missing(path);
      },
      async readdir(path, options = {}) {
        if (!directories.has(path)) throw missing(path);
        const prefix = path === "/" ? "/" : `${path}/`;
        const names = new Set();
        for (const candidate of [...directories, ...storedFiles.keys(), ...storedSymlinks]) {
          if (!candidate.startsWith(prefix)) continue;
          const name = candidate.slice(prefix.length).split("/")[0];
          if (name) names.add(name);
        }
        const entries = [...names].sort().map((name) => {
          const candidate = `${prefix}${name}`;
          if (storedSymlinks.has(candidate)) return dirent(name, "symlink", 0);
          if (storedFiles.has(candidate)) {
            return dirent(name, "file", storedFiles.get(candidate).byteLength);
          }
          return dirent(name, "directory", 0);
        });
        const offset = options.offset ?? 0;
        return entries.slice(offset, offset + (options.limit ?? entries.length));
      },
      async readFile(path, options = {}) {
        inspect.readCount += 1;
        const contents = storedFiles.get(path);
        if (!contents) throw missing(path);
        const offset = options.byteOffset ?? 0;
        const end = Math.min(contents.byteLength, offset + (options.byteLength ?? contents.byteLength));
        const selected = contents.slice(offset, end);
        const midpoint = Math.floor(selected.byteLength / 2);
        return byteStream(selected.slice(0, midpoint), selected.slice(midpoint));
      },
      async writeFile(path, contents) {
        inspect.writeCount += 1;
        storedFiles.set(path, contents.slice());
        addParents(directories, path);
      },
      async mkdir(path) {
        addParents(directories, `${path}/placeholder`);
        directories.add(path);
      },
      async rm(path, options = {}) {
        inspect.removeCount += 1;
        if (!storedFiles.has(path) && !directories.has(path) && !storedSymlinks.has(path)) {
          throw missing(path);
        }
        storedFiles.delete(path);
        storedSymlinks.delete(path);
        directories.delete(path);
        if (options.recursive) {
          for (const candidate of storedFiles.keys()) {
            if (candidate.startsWith(`${path}/`)) storedFiles.delete(candidate);
          }
          for (const candidate of storedSymlinks) {
            if (candidate.startsWith(`${path}/`)) storedSymlinks.delete(candidate);
          }
          for (const candidate of directories) {
            if (candidate.startsWith(`${path}/`)) directories.delete(candidate);
          }
        }
      },
    },
  };
}

function addParents(directories, path) {
  const segments = path.split("/").slice(1, -1);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    directories.add(current);
  }
}

function stat(kind, size) {
  return {
    size,
    isFile: kind === "file",
    isDirectory: kind === "directory",
    isSymbolicLink: kind === "symlink",
  };
}

function dirent(name, kind, size) {
  return { name, size, mtime: 7, ...stat(kind, size) };
}

function byteStream(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function missing(path) {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  return new TextEncoder().encode(value);
}

async function loadAdapter() {
  const source = await readFile(new URL("../src/computer-workspace.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2024,
    },
    fileName: "computer-workspace.ts",
    reportDiagnostics: true,
  });
  const errors = compiled.diagnostics?.filter((diagnostic) =>
    diagnostic.category === ts.DiagnosticCategory.Error
  ) ?? [];
  assert.deepEqual(errors, []);
  return import(`data:text/javascript,${encodeURIComponent(compiled.outputText)}`);
}
