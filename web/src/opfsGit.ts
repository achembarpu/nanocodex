const WORKSPACE_DIRECTORY = "nanocodex-workspaces";

export type OpfsPromises = ReturnType<typeof createPromises>;
export type OpfsGitFs = { promises: OpfsPromises };

export async function openOpfsGitFs(workspaceName: string): Promise<OpfsGitFs> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("Origin Private File System storage is unavailable in this browser");
  }
  const origin = await navigator.storage.getDirectory();
  const workspaces = await origin.getDirectoryHandle(WORKSPACE_DIRECTORY, { create: true });
  const root = await workspaces.getDirectoryHandle(encodeURIComponent(workspaceName), { create: true });
  return createOpfsGitFs(root);
}

export function createOpfsGitFs(root: FileSystemDirectoryHandle): OpfsGitFs {
  return { promises: createPromises(root) };
}

function createPromises(root: FileSystemDirectoryHandle) {
  return {
    async readFile(path?: string, options?: { encoding?: string } | string) {
      const relative = normalize(path);
      if (!relative) throw fsError("EISDIR", "cannot read a directory");
      try {
        const { parent, name } = await parentHandle(root, relative, false);
        const file = await (await parent.getFileHandle(name)).getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encoding = typeof options === "string" ? options : options?.encoding;
        return encoding ? new TextDecoder(encoding).decode(bytes) : bytes;
      } catch (error) {
        throw translateError(error, "ENOENT", `cannot read ${relative}`);
      }
    },
    async writeFile(path?: string, value?: unknown) {
      const relative = normalize(path);
      if (!relative) throw fsError("EISDIR", "cannot write a directory");
      try {
        const { parent, name } = await parentHandle(root, relative, false);
        const handle = await parent.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        try {
          await writable.write(asWriteValue(value));
          await writable.close();
        } catch (error) {
          await writable.abort(error).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        throw translateError(error, "ENOENT", `cannot write ${relative}`);
      }
    },
    async unlink(path?: string) {
      await remove(root, normalize(path), false);
    },
    async readdir(path?: string) {
      const directory = await directoryHandle(root, normalize(path), false);
      const names: string[] = [];
      const entries = (directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }).entries();
      for await (const [name] of entries) names.push(name);
      return names;
    },
    async mkdir(path?: string) {
      await directoryHandle(root, normalize(path), true);
    },
    async rmdir(path?: string) {
      const relative = normalize(path);
      if (!relative) throw fsError("EPERM", "cannot remove workspace root");
      await remove(root, relative, false);
    },
    async rm(path?: string, options?: { recursive?: boolean }) {
      const relative = normalize(path);
      if (!relative) throw fsError("EPERM", "cannot remove workspace root");
      await remove(root, relative, Boolean(options?.recursive));
    },
    async stat(path?: string) {
      return stat(root, normalize(path));
    },
    async lstat(path?: string) {
      return stat(root, normalize(path));
    },
    async readlink() {
      throw fsError("ENOSYS", "OPFS does not support symbolic links");
    },
    async symlink() {
      throw fsError("ENOSYS", "OPFS does not support symbolic links");
    },
  };
}

async function stat(root: FileSystemDirectoryHandle, relative: string) {
  try {
    const handle = relative ? await entryHandle(root, relative) : root;
    if (handle.kind === "directory") {
      return fileStat("directory", 0, 0);
    }
    const file = await handle.getFile();
    return fileStat("file", file.size, file.lastModified);
  } catch (error) {
    throw translateError(error, "ENOENT", `cannot stat ${relative}`);
  }
}

function fileStat(kind: "file" | "directory", size: number, modifiedAt: number) {
  return {
    size,
    mode: kind === "directory" ? 0o040755 : 0o100644,
    mtimeMs: modifiedAt,
    ctimeMs: modifiedAt,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => false,
  };
}

async function entryHandle(root: FileSystemDirectoryHandle, relative: string) {
  const { parent, name } = await parentHandle(root, relative, false);
  try {
    return await parent.getFileHandle(name);
  } catch (fileError) {
    try {
      return await parent.getDirectoryHandle(name);
    } catch {
      throw fileError;
    }
  }
}

async function directoryHandle(
  root: FileSystemDirectoryHandle,
  relative: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let directory = root;
  if (!relative) return directory;
  try {
    for (const segment of relative.split("/")) {
      directory = await directory.getDirectoryHandle(segment, { create });
    }
    return directory;
  } catch (error) {
    throw translateError(error, "ENOENT", `cannot open directory ${relative}`);
  }
}

async function parentHandle(root: FileSystemDirectoryHandle, relative: string, create: boolean) {
  const segments = relative.split("/");
  const name = segments.pop();
  if (!name) throw fsError("EINVAL", "path cannot be empty");
  return { parent: await directoryHandle(root, segments.join("/"), create), name };
}

async function remove(root: FileSystemDirectoryHandle, relative: string, recursive: boolean) {
  try {
    const { parent, name } = await parentHandle(root, relative, false);
    await parent.removeEntry(name, { recursive });
  } catch (error) {
    throw translateError(error, "ENOENT", `cannot remove ${relative}`);
  }
}

function normalize(path: string | undefined): string {
  if (typeof path !== "string") throw fsError("EINVAL", "path must be a string");
  const raw = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const relative = raw === "workspace" ? "" : raw.startsWith("workspace/") ? raw.slice(10) : raw;
  const segments: string[] = [];
  for (const segment of relative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") throw fsError("EPERM", "path escapes the workspace");
    segments.push(segment);
  }
  return segments.join("/");
}

function asWriteValue(value: unknown): FileSystemWriteChunkType {
  if (typeof value === "string" || value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return bytes;
  }
  throw fsError("EINVAL", "file contents must be bytes or text");
}

function translateError(error: unknown, fallback: string, message: string): Error & { code: string } {
  if (error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "string") {
    return error as Error & { code: string };
  }
  const name = error instanceof DOMException ? error.name : "";
  const code = name === "NotFoundError" ? "ENOENT"
    : name === "TypeMismatchError" ? "ENOTDIR"
      : name === "InvalidModificationError" ? "ENOTEMPTY"
        : name === "NoModificationAllowedError" ? "EPERM"
          : fallback;
  return fsError(code, message, error);
}

function fsError(code: string, message: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}
