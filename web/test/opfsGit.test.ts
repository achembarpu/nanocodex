import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatchFiles } from "@pierre/diffs";
import git from "isomorphic-git";

import { createBrowserBash, createOpfsGitFs } from "nanocodex/tools/browser";
import {
  MAX_COMMIT_HISTORY,
  MAX_COMMIT_PATCH_BYTES,
  buildThreadRepositorySnapshot,
} from "../src/threadRepositorySnapshot.ts";

test("an unborn thread exposes its OPFS working tree without inventing a commit", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  await fs.promises.writeFile("/workspace/App.tsx", "export default function App() {}\n");
  const snapshot = await buildThreadRepositorySnapshot(
    fs,
    "thread-12345678-1234-4123-8123-123456789abc",
    "nanocodex",
  );
  assert.equal(snapshot.repository.head, "unborn");
  assert.equal(snapshot.repository.totalCommits, 0);
  assert.deepEqual(snapshot.tree.map(({ path }) => path), ["App.tsx"]);
  snapshot.release();
});

test("the OPFS adapter supports a real isomorphic-git repository", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  await fs.promises.writeFile("/workspace/README.md", "# browser workspace\n");
  await git.add({ fs, dir: "/workspace", filepath: "README.md" });
  const oid = await git.commit({
    fs,
    dir: "/workspace",
    message: "Create workspace",
    author: { name: "Nanocodex", email: "agent@nanocodex.dev" },
  });
  assert.match(oid, /^[a-f0-9]{40}$/);
  assert.equal(await git.currentBranch({ fs, dir: "/workspace" }), "nanocodex");
  assert.deepEqual(await git.statusMatrix({ fs, dir: "/workspace" }), [
    ["README.md", 1, 1, 1],
  ]);

  await fs.promises.writeFile("/workspace/README.md", "# browser workspace\n\nNow backed by Git.\n");
  await fs.promises.writeFile(
    "/workspace/App.tsx",
    "export default function App() { return <main>Hello</main> }\n",
  );
  await git.add({ fs, dir: "/workspace", filepath: "README.md" });
  await git.add({ fs, dir: "/workspace", filepath: "App.tsx" });
  const head = await git.commit({
    fs,
    dir: "/workspace",
    message: "Add the React workspace",
    author: { name: "Nanocodex", email: "agent@nanocodex.dev" },
  });

  const snapshot = await buildThreadRepositorySnapshot(
    fs,
    "thread-12345678-1234-4123-8123-123456789abc",
    "nanocodex",
  );
  assert.equal(snapshot.repository.head, head);
  assert.equal(snapshot.repository.totalCommits, 2);
  assert.deepEqual(snapshot.tree.map(({ path }) => path), ["App.tsx", "README.md"]);
  assert.deepEqual(snapshot.commits[0]?.files.map(({ path, status }) => ({ path, status })), [
    { path: "App.tsx", status: "A" },
    { path: "README.md", status: "M" },
  ]);
  assert.equal(await snapshot.readFile(snapshot.tree[0]!),
    "export default function App() { return <main>Hello</main> }\n");
  const patch = await fetch(snapshot.commitPatchUrl).then((response) => response.text());
  assert.match(patch, new RegExp(`^From ${head}`));
  assert.match(patch, /diff --git a\/App\.tsx b\/App\.tsx/);
  assert.match(patch, /\+export default function App/);
  const parsed = parsePatchFiles(patch, "thread-test");
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0]?.files.map(({ name }) => name), ["App.tsx", "README.md"]);
  snapshot.release();
});

test("a lightweight repository snapshot defers HEAD blobs and commit history", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  await fs.promises.writeFile("/workspace/lazy.txt", "loaded on demand\n");
  await git.add({ fs, dir: "/workspace", filepath: "lazy.txt" });
  await git.commit({
    fs,
    dir: "/workspace",
    message: "Create lazy file",
    author: { name: "Nanocodex", email: "agent@nanocodex.dev" },
  });

  const snapshot = await buildThreadRepositorySnapshot(
    fs,
    "thread-test",
    "nanocodex",
    { includeHistory: false },
  );
  assert.equal(snapshot.historyLoaded, false);
  assert.equal(snapshot.commitPatchUrl, null);
  assert.deepEqual(snapshot.commits, []);
  assert.equal(snapshot.tree[0]?.size, null);
  assert.equal(await snapshot.readFile(snapshot.tree[0]!), "loaded on demand\n");
  snapshot.release();
});

test("commit snapshots cap history and classify unsafe diff blobs as binary", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  await fs.promises.writeFile("/workspace/large.txt", new Uint8Array(1024 * 1024 + 1).fill(97));
  await fs.promises.writeFile("/workspace/nul.txt", new Uint8Array([97, 0, 98]));
  await fs.promises.writeFile("/workspace/invalid.txt", new Uint8Array([0xc3, 0x28]));
  for (const path of ["large.txt", "nul.txt", "invalid.txt"]) {
    await git.add({ fs, dir: "/workspace", filepath: path });
  }
  await git.commit({
    fs,
    dir: "/workspace",
    message: "Add binary fixtures",
    author: { name: "Nanocodex", email: "agent@nanocodex.dev" },
  });
  const binarySnapshot = await buildThreadRepositorySnapshot(fs, "thread-test", "nanocodex");
  assert.deepEqual(
    binarySnapshot.commits[0]?.files.map(({ binary, additions, deletions }) => ({
      binary,
      additions,
      deletions,
    })),
    [
      { binary: true, additions: null, deletions: null },
      { binary: true, additions: null, deletions: null },
      { binary: true, additions: null, deletions: null },
    ],
  );
  const binaryPatch = await fetch(binarySnapshot.commitPatchUrl!)
    .then((response) => response.text());
  assert.equal(binaryPatch.match(/Binary files/g)?.length, 3);
  assert.ok(binaryPatch.length < 2_000);
  binarySnapshot.release();

  for (let index = 1; index <= MAX_COMMIT_HISTORY; index += 1) {
    await fs.promises.writeFile("/workspace/counter.txt", `${index}\n`);
    await git.add({ fs, dir: "/workspace", filepath: "counter.txt" });
    await git.commit({
      fs,
      dir: "/workspace",
      message: `Update ${index}`,
      author: { name: "Nanocodex", email: "agent@nanocodex.dev" },
    });
  }

  const snapshot = await buildThreadRepositorySnapshot(fs, "thread-test", "nanocodex");
  assert.equal(snapshot.commits.length, MAX_COMMIT_HISTORY);
  assert.equal(snapshot.commits.at(-1)?.subject, "Update 1");
  const patch = await fetch(snapshot.commitPatchUrl!).then((response) => response.text());
  assert.ok(patch.length <= MAX_COMMIT_PATCH_BYTES);
  snapshot.release();
});

test("commit patch memory is capped at four MiB", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const contents = "a\n".repeat((1024 * 1024 - 2) / 2);
  for (const path of ["one.txt", "two.txt", "three.txt", "four.txt"]) {
    await fs.promises.writeFile(`/workspace/${path}`, contents);
    await git.add({ fs, dir: "/workspace", filepath: path });
  }
  await git.commit({
    fs,
    dir: "/workspace",
    message: "Add large text files",
    author: { name: "Nanocodex", email: "agent@nanocodex.dev" },
  });

  const snapshot = await buildThreadRepositorySnapshot(fs, "thread-test", "nanocodex");
  const patch = await fetch(snapshot.commitPatchUrl!).then((response) => response.text());
  assert.ok(patch.length <= MAX_COMMIT_PATCH_BYTES);
  assert.match(patch, /Patch output truncated at 4 MiB/);
  snapshot.release();
});

test("just-bash and browser git share the same OPFS working tree", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const thread = {
    id: "12345678-1234-4123-8123-123456789abc",
    workspaceName: "nanocodex-thread-test",
    repositoryName: "thread-test",
    branch: "nanocodex" as const,
    remoteUrl: "https://example.test/git/thread-test",
    shareUrl: "https://example.test/?thread=test",
  };
  const { bash } = await createBrowserBash(fs, thread);

  const shellResult = await bash.exec("printf 'hello from bash\\n' > hello.txt && cat hello.txt");
  assert.equal(shellResult.stdout, "hello from bash\n");
  assert.equal(shellResult.stderr, "");
  assert.equal(shellResult.exitCode, 0);
  assert.equal(
    new TextDecoder().decode(await fs.promises.readFile("/workspace/hello.txt") as Uint8Array),
    "hello from bash\n",
  );
  assert.equal((await bash.exec("git status --short")).stdout, "?? hello.txt\n");
  assert.equal((await bash.exec("git add hello.txt && git commit -m 'Create hello'" )).exitCode, 0);
  assert.match((await bash.exec("git log --oneline -1")).stdout, /^[a-f0-9]{7} Create hello\n$/);
  assert.equal((await bash.exec("git status --short")).stdout, "");

  const artifactCli = await bash.exec("artifact --help");
  assert.equal(artifactCli.exitCode, 127);
  assert.match(artifactCli.stderr, /artifact: command not found/);
});

test("OPFS append preserves existing data and writes only the suffix at end", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await fs.promises.writeFile("/workspace/output.log", "existing");
  const file = root.entriesByName.get("output.log");
  assert(file instanceof MemoryFile);
  file.resetWriteInstrumentation();

  await fs.promises.appendFile("/workspace/output.log", "-one");
  await fs.promises.appendFile("/workspace/output.log", new TextEncoder().encode("-two"));

  assert.deepEqual(file.writableOptions, [
    { keepExistingData: true },
    { keepExistingData: true },
  ]);
  assert.deepEqual(file.seekPositions, [8, 12]);
  assert.deepEqual(file.writtenChunks.map((bytes) => new TextDecoder().decode(bytes)), ["-one", "-two"]);
  assert.equal(file.arrayBufferReads, 0);
  assert.equal(new TextDecoder().decode(file.bytes), "existing-one-two");
});

class MemoryDirectory {
  readonly kind = "directory";
  readonly entriesByName = new Map<string, MemoryDirectory | MemoryFile>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const current = this.entriesByName.get(name);
    if (current instanceof MemoryDirectory) return current;
    if (current) throw new DOMException("not a directory", "TypeMismatchError");
    if (!options?.create) throw new DOMException("not found", "NotFoundError");
    const directory = new MemoryDirectory();
    this.entriesByName.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const current = this.entriesByName.get(name);
    if (current instanceof MemoryFile) return current;
    if (current) throw new DOMException("not a file", "TypeMismatchError");
    if (!options?.create) throw new DOMException("not found", "NotFoundError");
    const file = new MemoryFile();
    this.entriesByName.set(name, file);
    return file;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    const current = this.entriesByName.get(name);
    if (!current) throw new DOMException("not found", "NotFoundError");
    if (current instanceof MemoryDirectory && current.entriesByName.size && !options?.recursive) {
      throw new DOMException("not empty", "InvalidModificationError");
    }
    this.entriesByName.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, MemoryDirectory | MemoryFile]> {
    yield* this.entriesByName.entries();
  }
}

class MemoryFile {
  readonly kind = "file";
  bytes = new Uint8Array();
  modifiedAt = Date.now();
  writableOptions: FileSystemCreateWritableOptions[] = [];
  seekPositions: number[] = [];
  writtenChunks: Uint8Array[] = [];
  arrayBufferReads = 0;

  resetWriteInstrumentation() {
    this.writableOptions = [];
    this.seekPositions = [];
    this.writtenChunks = [];
    this.arrayBufferReads = 0;
  }

  async getFile() {
    const bytes = this.bytes.slice();
    return {
      size: bytes.byteLength,
      lastModified: this.modifiedAt,
      arrayBuffer: async () => {
        this.arrayBufferReads += 1;
        return bytes.buffer;
      },
    };
  }

  async createWritable(options: FileSystemCreateWritableOptions = {}) {
    this.writableOptions.push({ ...options });
    let bytes = options.keepExistingData ? this.bytes.slice() : new Uint8Array();
    let position = 0;
    return {
      write: async (value: FileSystemWriteChunkType) => {
        const buffer = typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof Blob
            ? new Uint8Array(await value.arrayBuffer())
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        this.writtenChunks.push(buffer.slice());
        const length = Math.max(bytes.byteLength, position + buffer.byteLength);
        const next = new Uint8Array(length);
        next.set(bytes);
        next.set(buffer, position);
        bytes = next;
        position += buffer.byteLength;
      },
      seek: async (nextPosition: number) => {
        this.seekPositions.push(nextPosition);
        position = nextPosition;
      },
      close: async () => {
        this.bytes = bytes;
        this.modifiedAt = Date.now();
      },
      abort: async () => undefined,
    };
  }
}
