import assert from "node:assert/strict";
import { test } from "node:test";
import git from "isomorphic-git";
import { createCodeRuntime } from "../../js/bindings/runtime/code-runtime.mjs";
import { prepareBrowserShell } from "../../js/bindings/tools/browser/browserShell.mjs";
import { artifact as artifactTool } from "nanocodex/tools";

import {
  createBrowserBash,
  createOpfsGitFs,
  loadBrowserProjectInstructions,
  validateBrowserArtifactSource,
  type OpfsGitFs,
} from "nanocodex/tools/browser";

const observedLockSignals: Array<AbortSignal | undefined> = [];

Object.defineProperty(globalThis.navigator, "locks", {
  configurable: true,
  value: {
    request: async <T>(
      _name: string,
      optionsOrOperation: LockOptions | (() => Promise<T>),
      requestedOperation?: () => Promise<T>,
    ) => {
      const options = typeof optionsOrOperation === "function" ? undefined : optionsOrOperation;
      const operation = typeof optionsOrOperation === "function"
        ? optionsOrOperation
        : requestedOperation!;
      observedLockSignals.push(options?.signal);
      if (options?.signal?.aborted) throw options.signal.reason;
      return operation();
    },
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

test("browser project instructions prefer override files and enforce the native byte budget", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await fs.promises.mkdir("/workspace");
  await fs.promises.writeFile("/workspace/AGENTS.md", "default\n");
  const prefix = "override:";
  const source = `${prefix}${"x".repeat(32 * 1024 - prefix.length - 1)}€ignored`;
  await fs.promises.writeFile(
    "/workspace/AGENTS.override.md",
    source,
  );

  const warnings = await captureWarnings(() => loadBrowserProjectInstructions(fs));
  const expected = new TextDecoder().decode(
    new TextEncoder().encode(source).subarray(0, 32 * 1024),
  );
  assert.equal(warnings.value, expected);
  assert.match(warnings.value, /^override:/);
  assert.match(warnings.value, /�$/);
  assert.equal(warnings.messages.length, 1);
  assert.match(String(warnings.messages[0]?.[0]), /exceeds remaining budget/);

  const override = root.entriesByName.get("AGENTS.override.md");
  assert(override instanceof MemoryFile);
  assert.deepEqual(override.sliceRequests, [[0, 32 * 1024]]);
  assert.deepEqual(override.materializedByteLengths, [32 * 1024]);
});

test("browser project instruction selection matches native blank and non-file behavior", async () => {
  const blankRoot = new MemoryDirectory();
  const blankFs = createOpfsGitFs(blankRoot as unknown as FileSystemDirectoryHandle);
  await blankFs.promises.writeFile("/workspace/AGENTS.md", " default with spaces \n");
  await blankFs.promises.writeFile("/workspace/AGENTS.override.md", " \n\t");
  assert.equal(await loadBrowserProjectInstructions(blankFs), undefined);

  const directoryRoot = new MemoryDirectory();
  const directoryFs = createOpfsGitFs(directoryRoot as unknown as FileSystemDirectoryHandle);
  await directoryFs.promises.writeFile("/workspace/AGENTS.md", " default with spaces \n");
  await directoryFs.promises.mkdir("/workspace/AGENTS.override.md");
  assert.equal(
    await loadBrowserProjectInstructions(directoryFs),
    " default with spaces \n",
  );
});

test("browser project instruction read failures warn without falling through or aborting", async () => {
  const root = new MemoryDirectory();
  const base = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await base.promises.writeFile("/workspace/AGENTS.md", "default\n");
  await base.promises.writeFile("/workspace/AGENTS.override.md", "override\n");
  const fs: OpfsGitFs = {
    promises: {
      ...base.promises,
      async readFile(path, options) {
        if (path === "/workspace/AGENTS.override.md") {
          throw Object.assign(new Error("instruction disappeared"), { code: "ENOENT" });
        }
        return base.promises.readFile(path, options);
      },
    },
  };

  const warnings = await captureWarnings(() => loadBrowserProjectInstructions(fs));
  assert.equal(warnings.value, undefined);
  assert.equal(warnings.messages.length, 1);
  assert.match(String(warnings.messages[0]?.[0]), /failed to read project AGENTS\.md/);
});

test("the prepared browser harness observes workspace writes before its first lazy command", async () => {
  const origin = new MemoryDirectory();
  const workspaces = await origin.getDirectoryHandle("nanocodex-workspaces", { create: true });
  const workspaceName = `nanocodex-thread-${thread.id}`;
  const root = await workspaces.getDirectoryHandle(encodeURIComponent(workspaceName), { create: true });
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  await fs.promises.writeFile("/workspace/AGENTS.md", "lazy browser harness\n");
  const gitDirectory = root.entriesByName.get(".git");
  assert(gitDirectory instanceof MemoryDirectory);
  const configFile = gitDirectory.entriesByName.get("config");
  assert(configFile instanceof MemoryFile);
  const initialConfigWrites = configFile.writes;

  const previousStorage = Object.getOwnPropertyDescriptor(globalThis.navigator, "storage");
  let storageOpens = 0;
  let releaseGitStorage!: () => void;
  const gitStorage = new Promise<MemoryDirectory>((resolve) => {
    releaseGitStorage = () => resolve(origin);
  });
  Object.defineProperty(globalThis.navigator, "storage", {
    configurable: true,
    value: {
      getDirectory: async () => {
        const open = ++storageOpens;
        if (open === 2) releaseGitStorage();
        return open === 1 ? gitStorage : origin;
      },
    },
  });
  const statusMatrix = git.statusMatrix;
  let statusScans = 0;
  git.statusMatrix = (...args) => {
    statusScans += 1;
    return statusMatrix(...args);
  };
  try {
    const shell = await prepareBrowserShell(thread.id, "https://example.test");
    assert.equal(storageOpens, 2);
    assert.equal(statusScans, 0);
    assert(configFile.writes > initialConfigWrites);
    assert.equal(
      await git.getConfig({ fs, dir: "/workspace", path: "nanocodex.remote" }),
      `https://example.test/git/thread-${thread.id}`,
    );
    const configuredWrites = configFile.writes;
    await prepareBrowserShell(thread.id, "https://example.test");
    assert.equal(storageOpens, 3);
    assert.equal(configFile.writes, configuredWrites);
    assert.equal(shell.projectInstructions, "lazy browser harness\n");
    await shell.workspace.writeFile("/workspace/before-bash.txt", "visible on first command\n");
    const result = await shell.execTool.handler({
      cmd: "cat before-bash.txt && printf 'created by bash\\n' > after-bash.txt",
    }, { signal: new AbortController().signal });
    assert.equal(result.exit_code, 0);
    assert.equal(result.output, "visible on first command\n");
    assert.equal(
      new TextDecoder().decode(await shell.workspace.readFile("/workspace/after-bash.txt")),
      "created by bash\n",
    );
  } finally {
    git.statusMatrix = statusMatrix;
    if (previousStorage) Object.defineProperty(globalThis.navigator, "storage", previousStorage);
    else Reflect.deleteProperty(globalThis.navigator, "storage");
  }
});

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

test("browser exec forwards ToolContext cancellation through Web Locks and bash", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const shell = await createBrowserBash(fs, thread);
  const controller = new AbortController();
  const originalExec = shell.bash.exec.bind(shell.bash);
  let bashSignal: AbortSignal | undefined;
  shell.bash.exec = (script, options) => {
    bashSignal = options?.signal;
    return originalExec(script, options);
  };

  const result = await shell.exec({ cmd: "true" }, { signal: controller.signal });
  assert.equal(result.exit_code, 0);
  assert.equal(observedLockSignals.at(-1), bashSignal);
  assert.equal(bashSignal?.aborted, false);

  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled before lock acquisition"));
  await assert.rejects(
    shell.exec({ cmd: "touch cancelled.txt" }, { signal: cancelled.signal }),
    /cancelled before lock acquisition/,
  );
  assert.equal(observedLockSignals.at(-1)?.aborted, true);
  assert.match(String(observedLockSignals.at(-1)?.reason), /cancelled before lock acquisition/);
  await assert.rejects(fs.promises.stat("/workspace/cancelled.txt"), /cannot stat/);
});

test("browser command lookup stays inside the virtual workspace", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  await fs.promises.writeFile("/workspace/input.txt", "hello\n");
  const shell = await createBrowserBash(fs, thread);

  const result = await shell.exec({
    cmd: [
      "if command -v sha256sum >/dev/null 2>&1; then",
      "  sha256sum input.txt",
      "else",
      "  echo missing",
      "fi",
    ].join("\n"),
  });

  assert.equal(result.exit_code, 0);
  assert.doesNotMatch(result.output, /path escapes \/workspace/);
  assert.match(result.output, /^[0-9a-f]{64}  input\.txt\n$/);
  await assert.rejects(
    shell.exec({ cmd: "printf forbidden > /etc/forbidden" }),
    /path escapes \/workspace/,
  );
});

test("browser shell roundtrips gzip beside the local Git worktree", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const shell = await createBrowserBash(fs, thread);

  const result = await shell.exec({
    cmd: "printf 'browser gzip\\n' > input.txt && gzip -c input.txt > input.txt.gz && gzip -dc input.txt.gz && git status --short",
  });

  assert.equal(result.exit_code, 0);
  assert.match(result.output, /^browser gzip\n/);
  assert.match(result.output, /\?\? input\.txt/);
  assert.match(result.output, /\?\? input\.txt\.gz/);
});

test("browser compatibility commands expose uname and Fetch-backed curl", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const requests: Array<{ url: string; method?: string }> = [];
  const shell = await createBrowserBash(fs, thread, {
    fetch: async (url, options) => {
      requests.push({ url, method: options?.method });
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: new TextEncoder().encode("network works\n"),
        url,
      };
    },
  });

  const uname = await shell.exec({ cmd: "uname -srm" });
  assert.equal(uname.exit_code, 0);
  assert.equal(uname.output, "Nanocodex 1.0.0 wasm32\n");

  const curl = await shell.exec({ cmd: "curl -sS https://example.test/data" });
  assert.equal(curl.exit_code, 0);
  assert.equal(curl.output, "network works\n");
  assert.deepEqual(requests, [{ url: "https://example.test/data", method: "GET" }]);
});

test("browser python commands use the isolated runtime boundary", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const executions: Array<{ args: string[]; cwd: string; stdin: string }> = [];
  const shell = await createBrowserBash(fs, thread, {
    pythonRuntime: {
      async execute(input) {
        executions.push(input);
        return { stdout: "42\n", stderr: "", exitCode: 0 };
      },
    },
  });

  const result = await shell.exec({ cmd: "python3 -c 'print(6 * 7)'" });
  assert.equal(result.exit_code, 0);
  assert.equal(result.output, "42\n");
  assert.deepEqual(executions, [{
    args: ["-c", "print(6 * 7)"],
    cwd: "/workspace",
    stdin: "",
  }]);
});

test("elaborate Code Mode scripts compose concurrent browser commands into an artifact", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const shell = await createBrowserBash(fs, thread);
  const renderArtifact = artifactTool({
    workspace: artifactWorkspace(fs),
    validateSource: validateBrowserArtifactSource,
  });
  const runtime = createCodeRuntime({
    exec_command: {
      description: "Run a bash command in the browser thread workspace.",
      parameters: { type: "object" },
      handler: shell.exec,
    },
    [renderArtifact.name]: renderArtifact,
  });
  const artifactSource = `function App() {
  return html\`<main><h1>Code Mode total: 42</h1></main>\`;
}`;
  const execution = JSON.parse(await runtime.executeCode(`
    const inputs = [
      { path: "twenty.txt", value: 20 },
      { path: "twenty-one.txt", value: 21 },
      { path: "one.txt", value: 1 },
    ];
    const writes = await Promise.all(inputs.map(({ path, value }) =>
      tools.exec_command({ cmd: "printf '%s\\n' " + value + " > " + path })));
    const reads = await Promise.all(inputs.map(({ path }) =>
      tools.exec_command({ cmd: "cat " + path })));
    const values = reads
      .map(({ output }) => Number(output.trim()))
      .filter(Number.isFinite);
    const total = values.reduce((sum, value) => sum + value, 0);
    const source = ${JSON.stringify(artifactSource)};
    const published = await tools.render_artifact({
      id: "stress-ui",
      title: "Stress UI",
      source,
    });
    const verified = await tools.exec_command({
      cmd: "git status --short && cat .nanocodex/artifacts/stress-ui.json",
    });
    const summary = {
      total,
      writeExitCodes: writes.map(({ exit_code }) => exit_code),
      artifactId: published.artifactId,
      published: verified.output.includes("Code Mode total: 42"),
    };
    store("stress-summary", summary);
    text(summary);
  `, "stress-session", "stress-exec"));

  assert.equal(execution.success, true, execution.output);
  assert.equal(execution.nested_calls.length, 8);
  assert.deepEqual(
    execution.nested_calls.map((call: { call_id: string }) => call.call_id),
    Array.from({ length: 8 }, (_, index) => `stress-exec/code-${index + 1}`),
  );
  assert.deepEqual(
    execution.nested_calls.slice(0, 6).map((call: { success: boolean }) => call.success),
    [true, true, true, true, true, true],
  );
  assert.match(JSON.stringify(execution.output), /\\\"total\\\":42/);

  const retained = JSON.parse(await runtime.executeCode(
    'text(load("stress-summary"));',
    "stress-session",
    "stress-read",
  ));
  assert.equal(retained.success, true);
  assert.match(JSON.stringify(retained.output), /\\\"published\\\":true/);
  const artifact = JSON.parse(new TextDecoder().decode(
    await fs.promises.readFile("/workspace/.nanocodex/artifacts/stress-ui.json") as Uint8Array,
  ));
  assert.equal(artifact.title, "Stress UI");
  assert.match(artifact.source, /Code Mode total: 42/);
});

test("browser ssh documents its direct WebSocket-only transport", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const shell = await createBrowserBash(fs, thread);

  const result = await shell.exec({ cmd: "ssh --help" });
  assert.equal(result.exit_code, 2);
  assert.match(result.output, /wss:\/\/SSH-GATEWAY/);
  assert.match(result.output, /browsers cannot open TCP port 22/);
});

test("browser command substitutions settle without reaching the execution timeout", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  await fs.promises.writeFile("/workspace/input.txt", "first\nsecond\n");
  const shell = await createBrowserBash(fs, thread);

  const startedAt = performance.now();
  const result = await shell.exec({
    cmd: [
      "actual=$(cat input.txt)",
      "lines=$(wc -l < input.txt)",
      "hash=$(sha256sum input.txt)",
      "printf '%s|%s|%s\\n' \"$actual\" \"$lines\" \"$hash\"",
    ].join("\n"),
  });

  assert.equal(result.exit_code, 0);
  assert(performance.now() - startedAt < 2_000);
  assert.match(result.output, /^first\nsecond\|2\|[0-9a-f]{64}  input\.txt\n$/);
});

test("browser cancellation settles work running inside command substitution", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const shell = await createBrowserBash(fs, thread);
  const controller = new AbortController();

  const execution = shell.exec(
    { cmd: "value=$(sleep 30)\nprintf '%s\\n' \"$value\"" },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error("cancel nested work")), 10);

  const cancelled = await execution;
  assert.equal(cancelled.exit_code, 124);
  assert.match(cancelled.output, /execution aborted/i);
  const settled = await shell.exec({ cmd: "printf 'settled\\n'" });
  assert.equal(settled.output, "settled\n");
});

test("browser execution deadline aborts and settles command substitution work", async () => {
  const root = new MemoryDirectory();
  const fs = createOpfsGitFs(root as unknown as FileSystemDirectoryHandle);
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const shell = await createBrowserBash(fs, thread, { executionTimeoutMs: 20 });

  const startedAt = performance.now();
  const timedOut = await shell.exec({ cmd: "value=$(sleep 30)\nprintf '%s\\n' \"$value\"" });
  assert(performance.now() - startedAt < 1_000);
  assert.equal(timedOut.exit_code, 124);
  assert.match(timedOut.output, /execution aborted|deadline/i);
  const settled = await shell.exec({ cmd: "printf 'settled\\n'" });
  assert.equal(settled.output, "settled\n");
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
      async readFile(
        path?: string,
        options?: { encoding?: string; maxBytes?: number } | string,
      ) {
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

function artifactWorkspace(fs: OpfsGitFs) {
  return {
    root: "/workspace",
    async list() { return []; },
    async readFile(path: string) {
      return fs.promises.readFile(path) as Promise<Uint8Array>;
    },
    async writeFile(path: string, contents: string | ArrayBuffer | ArrayBufferView) {
      const bytes = typeof contents === "string"
        ? contents
        : contents instanceof ArrayBuffer
          ? new Uint8Array(contents)
          : new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
      await fs.promises.writeFile(path, bytes);
    },
    async remove(path: string) {
      await fs.promises.rm(path, { recursive: true });
    },
    async mkdir(path: string) {
      await fs.promises.mkdir(path);
    },
  };
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
  readonly sliceRequests: Array<[number, number | undefined]> = [];
  readonly materializedByteLengths: number[] = [];
  writes = 0;

  async getFile() {
    const bytes = this.bytes.slice();
    return this.fileView(bytes);
  }

  private fileView(bytes: Uint8Array) {
    return {
      size: bytes.byteLength,
      lastModified: this.modifiedAt,
      arrayBuffer: async () => {
        this.materializedByteLengths.push(bytes.byteLength);
        return bytes.buffer;
      },
      slice: (start = 0, end?: number) => {
        this.sliceRequests.push([start, end]);
        return this.fileView(bytes.slice(start, end));
      },
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
        this.writes += 1;
      },
      abort: async () => undefined,
    };
  }
}

async function captureWarnings<T>(operation: () => Promise<T>) {
  const messages: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => messages.push(args);
  try {
    return { messages, value: await operation() };
  } finally {
    console.warn = original;
  }
}
