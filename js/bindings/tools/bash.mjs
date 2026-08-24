import { namedTool } from "./namedTool.mjs";

const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_OUTPUT_TOKENS = 100_000;
const OUTPUT_TRUNCATION_NOTICE = "\n[output truncated by exec_command]";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEVICES = new Set(["/dev/full", "/dev/null", "/dev/stderr", "/dev/stdout"]);

const EXEC_PARAMETERS = Object.freeze({
  type: "object",
  properties: {
    cmd: { type: "string", description: "Bash command to execute." },
    workdir: { type: "string", description: "Working directory inside the virtual workspace." },
    max_output_tokens: { type: "integer", minimum: 1, maximum: MAX_OUTPUT_TOKENS },
    shell: { type: "string" },
    tty: { type: "boolean" },
    sandbox_permissions: { type: "string" },
  },
  required: ["cmd"],
  additionalProperties: true,
});

const EXEC_OUTPUT = Object.freeze({
  type: "object",
  properties: {
    wall_time_seconds: { type: "number" },
    exit_code: { type: "number" },
    original_token_count: { type: "number" },
    output: { type: "string" },
  },
  required: ["wall_time_seconds", "output"],
  additionalProperties: false,
});

const INSTRUCTIONS = `You have an in-process Bash interpreter and a persistent virtual filesystem rooted at /workspace.
Use exec_command for shell work such as ls, cat, find, grep, sed, and awk. Commands run
without a host process, container, PTY, or access outside /workspace. The shell is one-shot per call,
but files persist across calls and agent restarts. Network commands are unavailable unless the host
explicitly enables them, and model subscription credentials are never exposed to the shell.`;

export async function justBash(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Just Bash options must be an object");
  }
  validateWorkspace(options.filesystem);
  const executionTimeoutMs = positiveInteger(
    options.executionTimeoutMs,
    DEFAULT_EXECUTION_TIMEOUT_MS,
    "executionTimeoutMs",
  );
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
  const maxOutputTokens = Math.min(
    MAX_OUTPUT_TOKENS,
    positiveInteger(options.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, "maxOutputTokens"),
  );
  const shellFilesystem = new WorkspaceShellFileSystem(options.filesystem, maxEntries);
  await shellFilesystem.open();
  const filesystem = shellFilesystem.workspace();
  const { Bash } = await import("just-bash/browser");
  const bash = new Bash({
    cwd: filesystem.root,
    env: {
      HOME: filesystem.root,
      PWD: filesystem.root,
      PATH: filesystem.root,
    },
    fs: shellFilesystem,
    ...(typeof options.fetch === "function"
      ? { fetch: options.fetch }
      : options.network === false || options.network === undefined
        ? {}
        : { network: options.network }),
    ...(options.customCommands === undefined
      ? {}
      : { customCommands: [...options.customCommands] }),
    executionLimitProfile: "hardened",
    executionLimits: {
      maxCommandCount: 10_000,
      maxExecutionTimeMs: executionTimeoutMs,
      maxFileSystemBytes: 64 * 1024 * 1024,
      maxInputBytes: 16 * 1024 * 1024,
      maxLiveBytes: 32 * 1024 * 1024,
      maxOutputSize: maxOutputTokens * 4,
      maxSourceBytes: 1024 * 1024,
      maxStringLength: 16 * 1024 * 1024,
      maxTraversalEntries: maxEntries,
    },
  });
  let executionTail = Promise.resolve();

  const tool = namedTool("exec_command", {
    description: "Runs one bounded Bash command in the agent's persistent virtual workspace.",
    parameters: EXEC_PARAMETERS,
    outputSchema: EXEC_OUTPUT,
    handler(input, context) {
      const execute = () => executeCommand({
        bash,
        input,
        root: filesystem.root,
        signal: context?.signal,
        executionTimeoutMs,
        maxOutputTokens,
      });
      const result = executionTail.then(execute, execute);
      executionTail = result.then(() => undefined, () => undefined);
      return result;
    },
  });

  return Object.freeze({ filesystem, instructions: INSTRUCTIONS, tool });
}

async function executeCommand({
  bash,
  input,
  root,
  signal,
  executionTimeoutMs,
  maxOutputTokens,
}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("exec_command input must be an object");
  }
  if (typeof input.cmd !== "string" || !input.cmd.trim()) {
    throw new TypeError("exec_command.cmd must be a non-empty string");
  }
  if (input.tty === true) throw new Error("Just Bash does not provide PTY sessions");
  if (input.sandbox_permissions === "require_escalated") {
    throw new Error("Just Bash cannot escape its virtual workspace");
  }
  if (input.shell !== undefined && input.shell !== "bash" && input.shell !== "/bin/bash") {
    throw new Error("exec_command supports only the embedded Bash interpreter");
  }
  const workdir = input.workdir === undefined
    ? root
    : resolvePath(root, root, requiredString(input.workdir, "workdir"));
  const outputTokens = Math.min(
    maxOutputTokens,
    positiveInteger(input.max_output_tokens, maxOutputTokens, "max_output_tokens"),
  );
  const deadline = new AbortController();
  const abort = () => deadline.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(
    () => deadline.abort(new Error(`exec_command exceeded ${executionTimeoutMs} milliseconds`)),
    executionTimeoutMs,
  );
  const startedAt = now();
  let result;
  try {
    result = await bash.exec(input.cmd, { cwd: workdir, signal: deadline.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  const combined = `${result.stdout}${result.stderr}`;
  const maxCharacters = outputTokens * 4;
  const truncated = combined.length > maxCharacters;
  const retainedCharacters = Math.max(0, maxCharacters - OUTPUT_TRUNCATION_NOTICE.length);
  return {
    output: truncated
      ? maxCharacters >= OUTPUT_TRUNCATION_NOTICE.length
        ? `${combined.slice(0, retainedCharacters)}${OUTPUT_TRUNCATION_NOTICE}`
        : combined.slice(0, maxCharacters)
      : combined,
    wall_time_seconds: (now() - startedAt) / 1000,
    exit_code: result.exitCode,
    ...(truncated ? { original_token_count: Math.ceil(combined.length / 4) } : {}),
  };
}

class WorkspaceShellFileSystem {
  #source;
  #root;
  #maxEntries;
  #entries = new Map();
  #sortedPaths;

  constructor(workspace, maxEntries) {
    this.#source = workspace;
    this.#root = normalizeRoot(workspace.root);
    this.#maxEntries = maxEntries;
  }

  async open() {
    this.#entries.set(this.#root, directoryEntry());
    const entries = await this.#source.list(".", { recursive: true, maxEntries: this.#maxEntries });
    for (const entry of entries) {
      const path = resolvePath(this.#root, this.#root, entry.path);
      this.#addParents(path);
      this.#set(path, entry.kind === "directory"
        ? directoryEntry(entry.modifiedAt)
        : fileEntry(entry.size, entry.modifiedAt));
    }
  }

  workspace() {
    return Object.freeze({
      root: this.#root,
      list: (path = ".", options) => this.#source.list(
        resolvePath(this.#root, this.#root, path),
        options,
      ),
      readFile: (path) => this.#source.readFile(resolvePath(this.#root, this.#root, path)),
      writeFile: async (path, contents) => {
        const absolute = resolvePath(this.#root, this.#root, path);
        const bytes = bytesFrom(contents);
        this.#assertCapacity(absolute);
        await this.#source.writeFile(absolute, bytes);
        this.#addParents(absolute);
        this.#set(absolute, fileEntry(bytes.byteLength));
      },
      remove: async (path, options) => {
        const absolute = resolvePath(this.#root, this.#root, path);
        await this.#source.remove(absolute, options);
        this.#remove(absolute);
      },
      mkdir: async (path) => {
        const absolute = resolvePath(this.#root, this.#root, path);
        this.#assertCapacity(absolute);
        await this.#source.mkdir(absolute);
        this.#addParents(absolute);
        this.#set(absolute, directoryEntry());
      },
    });
  }

  async readFile(path, options) {
    return decode(await this.readFileBuffer(path), encoding(options));
  }

  async readFileBytes(path) {
    return bytesToLatin1(await this.readFileBuffer(path));
  }

  async readFileBuffer(path) {
    const absolute = this.#resolve(path);
    if (absolute === "/dev/null") return new Uint8Array();
    const entry = this.#require(absolute);
    if (entry.kind !== "file") throw fsError("EISDIR", `${absolute} is a directory`);
    return this.#source.readFile(absolute);
  }

  async writeFile(path, content, options) {
    const absolute = this.#resolve(path);
    if (absolute === "/dev/null") return;
    const bytes = encode(content, encoding(options));
    this.#assertCapacity(absolute);
    await this.#source.writeFile(absolute, bytes);
    this.#addParents(absolute);
    this.#set(absolute, fileEntry(bytes.byteLength));
  }

  async appendFile(path, content, options) {
    const absolute = this.#resolve(path);
    if (absolute === "/dev/null") return;
    const suffix = encode(content, encoding(options));
    const prefix = await this.exists(absolute) ? await this.readFileBuffer(absolute) : new Uint8Array();
    const joined = new Uint8Array(prefix.byteLength + suffix.byteLength);
    joined.set(prefix);
    joined.set(suffix, prefix.byteLength);
    await this.writeFile(absolute, joined);
  }

  async exists(path) {
    try {
      const absolute = this.#resolve(path);
      return DEVICES.has(absolute) || this.#entries.has(absolute);
    } catch (error) {
      if (error?.code === "EPERM") return false;
      throw error;
    }
  }

  async stat(path) {
    const absolute = this.#resolve(path);
    if (DEVICES.has(absolute)) return statResult(fileEntry(0, 0), absolute);
    return statResult(this.#require(absolute), absolute);
  }

  lstat(path) {
    return this.stat(path);
  }

  async mkdir(path, options = {}) {
    const absolute = resolvePath(this.#root, this.#root, path);
    const existing = this.#entries.get(absolute);
    if (existing) {
      if (options.recursive && existing.kind === "directory") return;
      throw fsError("EEXIST", `${absolute} already exists`);
    }
    const parent = parentPath(absolute);
    if (!options.recursive && !this.#entries.has(parent)) {
      throw fsError("ENOENT", `parent directory ${parent} does not exist`);
    }
    this.#assertCapacity(absolute);
    await this.#source.mkdir(absolute);
    this.#addParents(absolute);
    this.#set(absolute, directoryEntry());
  }

  async readdir(path) {
    const absolute = resolvePath(this.#root, this.#root, path);
    const entry = this.#require(absolute);
    if (entry.kind !== "directory") throw fsError("ENOTDIR", `${absolute} is not a directory`);
    const prefix = `${absolute}/`;
    const names = new Set();
    for (const candidate of this.#entries.keys()) {
      if (!candidate.startsWith(prefix)) continue;
      const remainder = candidate.slice(prefix.length);
      if (remainder && !remainder.includes("/")) names.add(remainder);
    }
    return [...names].sort();
  }

  async readdirWithFileTypes(path) {
    const absolute = resolvePath(this.#root, this.#root, path);
    return Promise.all((await this.readdir(absolute)).map(async (name) => {
      const entry = this.#require(`${absolute}/${name}`);
      return {
        name,
        isFile: entry.kind === "file",
        isDirectory: entry.kind === "directory",
        isSymbolicLink: false,
      };
    }));
  }

  async rm(path, options = {}) {
    const absolute = resolvePath(this.#root, this.#root, path);
    if (absolute === this.#root) throw fsError("EPERM", "cannot remove the workspace root");
    const entry = this.#entries.get(absolute);
    if (!entry) {
      if (options.force) return;
      throw fsError("ENOENT", `${absolute} does not exist`);
    }
    if (entry.kind === "directory" && !options.recursive && this.#hasChildren(absolute)) {
      throw fsError("ENOTEMPTY", `${absolute} is not empty`);
    }
    await this.#source.remove(absolute, { recursive: options.recursive === true });
    this.#remove(absolute);
  }

  async cp(sourcePath, destinationPath, options = {}) {
    const source = resolvePath(this.#root, this.#root, sourcePath);
    const destination = resolvePath(this.#root, this.#root, destinationPath);
    const entry = this.#require(source);
    if (entry.kind === "directory") {
      if (!options.recursive) throw fsError("EISDIR", "copying a directory requires recursive mode");
      await this.mkdir(destination, { recursive: true });
      for (const name of await this.readdir(source)) {
        await this.cp(`${source}/${name}`, `${destination}/${name}`, options);
      }
      return;
    }
    await this.writeFile(destination, await this.readFileBuffer(source));
  }

  async mv(source, destination) {
    await this.cp(source, destination, { recursive: true });
    await this.rm(source, { recursive: true });
  }

  resolvePath(base, path) {
    return resolvePath(this.#root, base, path);
  }

  getAllPaths() {
    this.#sortedPaths ??= [...this.#entries.keys()].sort();
    return this.#sortedPaths.slice();
  }

  async chmod(path) {
    await this.stat(path);
  }

  async symlink() {
    throw fsError("ENOSYS", "the mounted workspace does not support symbolic links");
  }

  async link() {
    throw fsError("ENOSYS", "the mounted workspace does not support hard links");
  }

  async readlink() {
    throw fsError("ENOSYS", "the mounted workspace does not support symbolic links");
  }

  async realpath(path) {
    const absolute = resolvePath(this.#root, this.#root, path);
    await this.stat(absolute);
    return absolute;
  }

  async utimes(path) {
    await this.stat(path);
  }

  #resolve(path) {
    if (DEVICES.has(path)) return path;
    return resolvePath(this.#root, this.#root, path);
  }

  #require(path) {
    const entry = this.#entries.get(path);
    if (!entry) throw fsError("ENOENT", `${path} does not exist`);
    return entry;
  }

  #set(path, entry) {
    if (!this.#entries.has(path) && this.#entries.size - 1 >= this.#maxEntries) {
      throw fsError("EFBIG", `workspace exceeds ${this.#maxEntries} entries`);
    }
    this.#entries.set(path, entry);
    this.#sortedPaths = undefined;
  }

  #assertCapacity(path) {
    let additions = this.#entries.has(path) ? 0 : 1;
    const relative = path.slice(this.#root.length + 1);
    let current = this.#root;
    for (const segment of relative.split("/").slice(0, -1)) {
      current += `/${segment}`;
      if (!this.#entries.has(current)) additions += 1;
    }
    if (additions > this.#maxEntries - (this.#entries.size - 1)) {
      throw fsError("EFBIG", `workspace exceeds ${this.#maxEntries} entries`);
    }
  }

  #addParents(path) {
    const relative = path.slice(this.#root.length + 1);
    if (!relative) return;
    let current = this.#root;
    for (const segment of relative.split("/").slice(0, -1)) {
      current += `/${segment}`;
      if (!this.#entries.has(current)) this.#set(current, directoryEntry());
    }
  }

  #remove(path) {
    for (const candidate of this.#entries.keys()) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.#entries.delete(candidate);
    }
    this.#sortedPaths = undefined;
  }

  #hasChildren(path) {
    for (const candidate of this.#entries.keys()) {
      if (candidate.startsWith(`${path}/`)) return true;
    }
    return false;
  }
}

function directoryEntry(modifiedAt = Date.now()) {
  return { kind: "directory", modifiedAt, size: 0 };
}

function fileEntry(size = 0, modifiedAt = Date.now()) {
  return { kind: "file", modifiedAt, size: size ?? 0 };
}

function statResult(entry, path) {
  return {
    isFile: entry.kind === "file",
    isDirectory: entry.kind === "directory",
    isSymbolicLink: false,
    mode: entry.kind === "directory" ? 0o755 : 0o644,
    size: entry.size ?? 0,
    mtime: new Date(entry.modifiedAt ?? 0),
    identity: `workspace:${path}`,
  };
}

function resolvePath(root, base, path) {
  if (typeof path !== "string" || path.includes("\0")) throw fsError("EINVAL", "invalid path");
  const safeBase = normalizeRoot(base);
  if (safeBase !== root && !safeBase.startsWith(`${root}/`)) {
    throw fsError("EPERM", `working directory escapes ${root}`);
  }
  const source = path.startsWith("/") ? path : `${safeBase}/${path}`;
  const segments = [];
  for (const segment of source.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const absolute = `/${segments.join("/")}`;
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw fsError("EPERM", `path escapes ${root}`);
  }
  return absolute;
}

function normalizeRoot(root) {
  if (typeof root !== "string" || !root.startsWith("/")) {
    throw new TypeError("workspace root must be an absolute path");
  }
  const normalized = `/${root.split("/").filter((segment) => segment && segment !== ".").join("/")}`;
  if (normalized === "/" || normalized.includes("/../") || normalized.endsWith("/..")) {
    throw new TypeError("workspace root must be a bounded absolute path");
  }
  return normalized;
}

function parentPath(path) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function encoding(options) {
  return typeof options === "string" ? options : options?.encoding ?? "utf8";
}

function encode(content, selectedEncoding) {
  if (content instanceof Uint8Array) return content;
  if (selectedEncoding === "base64") {
    return Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  }
  if (selectedEncoding === "hex") {
    if (content.length % 2 !== 0 || !/^[a-f0-9]*$/i.test(content)) {
      throw fsError("EINVAL", "invalid hex input");
    }
    return Uint8Array.from(content.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  }
  if (["binary", "latin1", "ascii"].includes(selectedEncoding)) {
    return Uint8Array.from(content, (character) => character.charCodeAt(0) & 0xff);
  }
  return encoder.encode(content);
}

function decode(bytes, selectedEncoding) {
  if (selectedEncoding === "base64") return btoa(bytesToLatin1(bytes));
  if (selectedEncoding === "hex") {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  if (selectedEncoding === "binary" || selectedEncoding === "latin1") return bytesToLatin1(bytes);
  if (selectedEncoding === "ascii") {
    return bytesToLatin1(Uint8Array.from(bytes, (byte) => byte & 0x7f));
  }
  return decoder.decode(bytes);
}

function bytesFrom(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("workspace contents must be a string or byte array");
}

function bytesToLatin1(bytes) {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return output;
}

function validateWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object" || typeof workspace.root !== "string") {
    throw new TypeError("Just Bash requires a workspace handle");
  }
  for (const method of ["list", "readFile", "writeFile", "remove", "mkdir"]) {
    if (typeof workspace[method] !== "function") {
      throw new TypeError(`workspace handle requires ${method}()`);
    }
  }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be non-empty`);
  return value;
}

function fsError(code, message) {
  return Object.assign(new Error(message), { code });
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}
