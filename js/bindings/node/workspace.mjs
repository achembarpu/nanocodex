import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open as openFile,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { createWorkspace, normalizeRelativePath, tools } from "../runtime/workspace.mjs";

export { tools };

export async function open(options = {}) {
  if (typeof options.path !== "string" || !options.path) {
    throw new TypeError("Node workspace path must be a non-empty string");
  }
  const directory = resolve(options.path);
  await mkdir(directory, { recursive: true });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Node workspace path must be a real directory: ${directory}`);
  }
  return createWorkspace({
    root: directory,
    backend: nodeBackend(directory),
  });
}

function nodeBackend(root) {
  return {
    async list(path, { recursive, maxEntries }) {
      const directory = await resolveDirectory(root, path, false);
      const output = [];
      await listDirectory(root, directory, path, recursive, maxEntries, output);
      return output.sort((left, right) => left.path.localeCompare(right.path));
    },
    async readFile(path) {
      return new Uint8Array(await readFile(await resolveFile(root, path)));
    },
    async writeFile(path, contents) {
      const { directory, name } = await resolveParent(root, path, true);
      const target = join(directory, name);
      await rejectSymlink(target, { optional: true });
      const temporary = join(directory, `.nanocodex-${randomUUID()}.tmp`);
      const handle = await openFile(temporary, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        await handle.close();
        await rename(temporary, target);
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
    async remove(path, { recursive }) {
      const { directory, name } = await resolveParent(root, path, false);
      const target = join(directory, name);
      await rejectSymlink(target);
      await rm(target, { recursive, force: false });
    },
    async mkdir(path) {
      await resolveDirectory(root, path, true);
    },
  };
}

async function listDirectory(root, directory, prefix, recursive, maxEntries, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= maxEntries) {
      throw new RangeError(`workspace listing exceeds ${maxEntries} entries`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`workspace refuses symbolic link: ${displayRelative(prefix, entry.name)}`);
    }
    const path = displayRelative(prefix, entry.name);
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push({ kind: "directory", path });
      if (recursive) await listDirectory(root, absolute, path, true, maxEntries, output);
      continue;
    }
    if (!entry.isFile()) throw new Error(`unsupported workspace entry: ${path}`);
    const metadata = await lstat(absolute);
    output.push({
      kind: "file",
      modifiedAt: metadata.mtimeMs,
      path,
      size: metadata.size,
    });
  }
}

async function resolveFile(root, path) {
  const { directory, name } = await resolveParent(root, path, false);
  const target = join(directory, name);
  const metadata = await rejectSymlink(target);
  if (!metadata.isFile()) throw new Error(`workspace path is not a file: ${path}`);
  return target;
}

async function resolveParent(root, path, create) {
  const relative = normalizeRelativePath(path);
  const segments = relative.split("/");
  const name = segments.pop();
  if (!name) throw new Error("workspace file path cannot be empty");
  return {
    directory: await resolveDirectory(root, segments.join("/"), create),
    name,
  };
}

async function resolveDirectory(root, path, create) {
  let directory = root;
  const relative = normalizeRelativePath(path);
  if (!relative) return directory;
  for (const segment of relative.split("/")) {
    directory = join(directory, segment);
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error;
      await mkdir(directory);
      metadata = await lstat(directory);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`workspace directory path is unsafe: ${path}`);
    }
  }
  assertInside(root, directory);
  return directory;
}

async function rejectSymlink(path, { optional = false } = {}) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`workspace refuses symbolic link: ${path}`);
    return metadata;
  } catch (error) {
    if (optional && error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertInside(root, path) {
  const relative = path.slice(root.length);
  if (!isAbsolute(root) || (relative && !relative.startsWith("/"))) {
    throw new Error(`workspace path escaped its root: ${path}`);
  }
}

function displayRelative(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}
