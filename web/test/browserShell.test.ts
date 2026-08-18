import assert from "node:assert/strict";
import { test } from "node:test";
import git from "isomorphic-git";

import { createBrowserBash } from "../src/browserShell.ts";
import { createOpfsGitFs, type OpfsGitFs } from "../src/opfsGit.ts";

Object.defineProperty(globalThis.navigator, "locks", {
  configurable: true,
  value: {
    request: async <T>(_name: string, operation: () => Promise<T>) => operation(),
  },
});

const thread = {
  id: "12345678-1234-4123-8123-123456789abc",
  workspaceName: "nanocodex-thread-browser-shell-test",
  repositoryName: "thread-browser-shell-test",
  branch: "nanocodex" as const,
  remoteUrl: "https://example.test/git/thread-browser-shell-test",
  shareUrl: "https://example.test/?thread=browser-shell-test",
};

test("browser shell indexes the worktree once and notifies only for mutations", async () => {
  const root = new MemoryDirectory();
  const baseFs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs: baseFs, dir: "/workspace", defaultBranch: "nanocodex" });
  await baseFs.promises.mkdir("/workspace/.git/index-probe");
  await baseFs.promises.writeFile("/workspace/.git/index-probe/object", "internal\n");
  await baseFs.promises.mkdir("/workspace/src");
  await baseFs.promises.writeFile("/workspace/src/index.ts", "export {};\n");
  await baseFs.promises.writeFile("/workspace/README.md", "# workspace\n");

  const { counters, fs } = instrument(baseFs);
  let notifications = 0;
  const shell = await createBrowserBash(fs, thread, {
    onChanged: () => notifications += 1,
  });
  assert.equal(
    shell.filesystem.getAllPaths().some((path) => path === "/workspace/.git" || path.startsWith("/workspace/.git/")),
    false,
  );
  assert(shell.filesystem.getAllPaths().includes("/workspace/src/index.ts"));
  assert.equal(counters.stat, 0);
  assert.equal(counters.readdirWithFileTypes, 2);
  const indexedReaddir = counters.readdir;

  const read = await shell.exec({ cmd: "cat README.md" });
  assert.equal(read.exit_code, 0);
  assert.equal(read.output, "# workspace\n");
  assert.equal(counters.readdir, indexedReaddir);
  assert.equal(notifications, 0);

  const write = await shell.exec({ cmd: "mkdir generated && printf 'hello\\n' > generated/result.txt" });
  assert.equal(write.exit_code, 0);
  assert.equal(notifications, 1);
  assert.equal(counters.readdir, indexedReaddir);
  assert(shell.filesystem.getAllPaths().includes("/workspace/generated/result.txt"));

  const secondRead = await shell.exec({ cmd: "cat generated/result.txt" });
  assert.equal(secondRead.output, "hello\n");
  assert.equal(notifications, 1);
  assert.equal(counters.readdir, indexedReaddir);

  const remove = await shell.exec({ cmd: "rm -r generated" });
  assert.equal(remove.exit_code, 0);
  assert.equal(notifications, 2);
  assert.equal(
    shell.filesystem.getAllPaths().some((path) => path.startsWith("/workspace/generated")),
    false,
  );
});

test("browser shell appends through OPFS and reports one mutation", async () => {
  const root = new MemoryDirectory();
  const baseFs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs: baseFs, dir: "/workspace", defaultBranch: "nanocodex" });
  await baseFs.promises.writeFile("/workspace/output.log", "existing\n");

  const { counters, fs } = instrument(baseFs);
  let notifications = 0;
  const shell = await createBrowserBash(fs, thread, {
    onChanged: () => notifications += 1,
  });
  counters.appended.length = 0;
  counters.readFile = 0;
  counters.writeFile = 0;

  const append = await shell.exec({ cmd: "printf 'suffix\\n' >> output.log" });
  assert.equal(append.exit_code, 0);
  assert.equal(
    new TextDecoder().decode(await baseFs.promises.readFile("/workspace/output.log") as Uint8Array),
    "existing\nsuffix\n",
  );
  assert.equal(notifications, 1);
  assert.equal(counters.readFile, 0);
  assert.equal(counters.writeFile, 0);
  assert.deepEqual(counters.appended.map((bytes) => new TextDecoder().decode(bytes)), ["", "suffix\n"]);
  assert(shell.filesystem.getAllPaths().includes("/workspace/output.log"));
});

test("browser git bounds log depth and avoids text diffs for oversized files", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  await fs.promises.writeFile("/workspace/README.md", "before\n");
  await git.add({ fs, dir: "/workspace", filepath: "README.md" });
  await git.commit({
    fs,
    dir: "/workspace",
    message: "Initial commit",
    author: { name: "Nanocodex", email: "agent@nanocodex.dev" },
  });
  await fs.promises.writeFile("/workspace/README.md", "after\n");
  await fs.promises.writeFile("/workspace/large.txt", new Uint8Array(1024 * 1024 + 1).fill(97));
  await fs.promises.writeFile("/workspace/binary.dat", new Uint8Array([0, 1, 2, 3]));

  let notifications = 0;
  const shell = await createBrowserBash(fs, thread, {
    onChanged: () => notifications += 1,
  });
  const diff = await shell.exec({ cmd: "git diff" });
  assert.equal(diff.exit_code, 0);
  assert.match(diff.output, /\+after/);
  assert.match(diff.output, /Binary files \/dev\/null and b\/large\.txt differ/);
  assert.match(diff.output, /Binary files \/dev\/null and b\/binary\.dat differ/);
  assert(diff.output.length <= 4 * 1024 * 1024);
  assert.equal(notifications, 0);

  const add = await shell.exec({ cmd: "git add README.md" });
  assert.equal(add.exit_code, 0);
  assert.equal(notifications, 1);
  const commit = await shell.exec({ cmd: "git commit -m 'Update readme'" });
  assert.equal(commit.exit_code, 0);
  assert.equal(notifications, 2);

  const log = await shell.exec({ cmd: "git log -201" });
  assert.equal(log.exit_code, 1);
  assert.match(log.output, /log depth cannot exceed 200/);
  assert.equal(notifications, 2);
});

function instrument(base: OpfsGitFs) {
  const counters = {
    readdir: 0,
    readdirWithFileTypes: 0,
    stat: 0,
    readFile: 0,
    writeFile: 0,
    appended: [] as Uint8Array[],
  };
  const fs: OpfsGitFs = {
    promises: {
      ...base.promises,
      async readFile(path?: string, options?: { encoding?: string } | string) {
        counters.readFile += 1;
        return base.promises.readFile(path, options);
      },
      async writeFile(path?: string, value?: unknown) {
        counters.writeFile += 1;
        return base.promises.writeFile(path, value);
      },
      async appendFile(path?: string, value?: unknown) {
        const bytes = value instanceof Uint8Array ? value.slice() : new TextEncoder().encode(String(value ?? ""));
        counters.appended.push(bytes);
        return base.promises.appendFile(path, value);
      },
      async readdir(path?: string) {
        counters.readdir += 1;
        return base.promises.readdir(path);
      },
      async readdirWithFileTypes(path?: string) {
        counters.readdirWithFileTypes += 1;
        return base.promises.readdirWithFileTypes(path);
      },
      async stat(path?: string) {
        counters.stat += 1;
        return base.promises.stat(path);
      },
    },
  };
  return { counters, fs };
}

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

  async createWritable(options?: FileSystemCreateWritableOptions) {
    let bytes = options?.keepExistingData ? this.bytes.slice() : new Uint8Array();
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
        const length = Math.max(bytes.byteLength, position + buffer.byteLength);
        const next = new Uint8Array(length);
        next.set(bytes);
        next.set(buffer, position);
        bytes = next;
        position += buffer.byteLength;
      },
      seek: async (nextPosition: number) => {
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
