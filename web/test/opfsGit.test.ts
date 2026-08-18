import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatchFiles } from "@pierre/diffs";
import git from "isomorphic-git";

import { createBrowserBash } from "../src/browserShell.ts";
import { createOpfsGitFs } from "../src/opfsGit.ts";
import { buildThreadRepositorySnapshot } from "../src/threadRepositorySnapshot.ts";

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
  assert.equal(
    await fetch(snapshot.tree[0]!.contentUrl!).then((response) => response.text()),
    "export default function App() { return <main>Hello</main> }\n",
  );
  const patch = await fetch(snapshot.commitPatchUrl).then((response) => response.text());
  assert.match(patch, new RegExp(`^From ${head}`));
  assert.match(patch, /diff --git a\/App\.tsx b\/App\.tsx/);
  assert.match(patch, /\+export default function App/);
  const parsed = parsePatchFiles(patch, "thread-test");
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0]?.files.map(({ name }) => name), ["App.tsx", "README.md"]);
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

  await bash.exec("printf 'function App() { return html`<main>Hello</main>`; }\\n' > hello-ui.js");
  const publish = await bash.exec("artifact publish hello-ui.js --id hello --title 'Hello UI'");
  assert.equal(publish.exitCode, 0);
  assert.match(publish.stdout, /Published hello/);
  const artifact = JSON.parse(new TextDecoder().decode(
    await fs.promises.readFile("/workspace/.nanocodex/artifacts/hello.json") as Uint8Array,
  ));
  assert.equal(artifact.title, "Hello UI");
  assert.match(artifact.source, /function App/);
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

  async getFile() {
    const bytes = this.bytes.slice();
    return {
      size: bytes.byteLength,
      lastModified: this.modifiedAt,
      arrayBuffer: async () => bytes.buffer,
    };
  }

  async createWritable() {
    return {
      write: async (value: FileSystemWriteChunkType) => {
        const buffer = typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof Blob
            ? new Uint8Array(await value.arrayBuffer())
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        this.bytes = buffer.slice();
        this.modifiedAt = Date.now();
      },
      close: async () => undefined,
      abort: async () => undefined,
    };
  }
}
