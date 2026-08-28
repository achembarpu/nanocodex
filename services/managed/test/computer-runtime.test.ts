import { describe, expect, it, vi } from "vitest";

import { createManagedComputerRuntime } from "../src/computer-runtime";

describe("managed Computer runtime", () => {
  it("shares one mounted filesystem and command set across every consumer", async () => {
    const computer = memoryComputer();
    const runtime = await createManagedComputerRuntime({
      computer,
      egress: { fetch: vi.fn() } as unknown as Fetcher,
    });

    const context = {
      callId: "shared-computer",
      parentCallId: "",
      sessionId: "test",
      signal: new AbortController().signal,
    };
    expect(await runtime.tool.handler({
      cmd: "mkdir -p repo && printf shell-file > repo/from-shell.txt",
    }, context)).toMatchObject({ exit_code: 0 });
    expect(new TextDecoder().decode(
      await runtime.filesystem.readFile("repo/from-shell.txt"),
    )).toBe("shell-file");

    await runtime.filesystem.writeFile("repo/from-tool.txt", "tool-file");
    expect(await runtime.tool.handler({
      cmd: "cat repo/from-tool.txt && git status",
    }, context)).toMatchObject({
      exit_code: 1,
      output: expect.stringContaining("tool-filegit: not a git repository"),
    });
    expect(runtime.commandNames).toEqual(["gh", "git"]);

    runtime.dispose();
    runtime.dispose();
    expect(computer.inspect.dispose).toHaveBeenCalledTimes(1);
  });
});

function memoryComputer() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(["/workspace"]);
  const dispose = vi.fn();
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const stat = (kind: "file" | "directory", size = 0) => ({
    size,
    isFile: kind === "file",
    isDirectory: kind === "directory",
    isSymbolicLink: false,
  });
  const addParents = (path: string) => {
    const segments = path.split("/").slice(1, -1);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      directories.add(current);
    }
  };

  return {
    inspect: { dispose },
    [Symbol.dispose]: dispose,
    fs: {
      async lstat(path: string) {
        if (files.has(path)) return stat("file", files.get(path)!.byteLength);
        if (directories.has(path)) return stat("directory");
        throw missing(path);
      },
      async readdir(path: string, options: { limit?: number; offset?: number } = {}) {
        if (!directories.has(path)) throw missing(path);
        const prefix = `${path}/`;
        const names = new Set<string>();
        for (const candidate of [...directories, ...files.keys()]) {
          if (!candidate.startsWith(prefix)) continue;
          const name = candidate.slice(prefix.length).split("/")[0];
          if (name) names.add(name);
        }
        const entries = [...names].sort().map((name) => {
          const candidate = `${prefix}${name}`;
          const entry = files.has(candidate)
            ? stat("file", files.get(candidate)!.byteLength)
            : stat("directory");
          return { name, mtime: 1, ...entry };
        });
        const offset = options.offset ?? 0;
        return entries.slice(offset, offset + (options.limit ?? entries.length));
      },
      async readFile(path: string, options: { byteOffset?: number; byteLength?: number } = {}) {
        const contents = files.get(path);
        if (!contents) throw missing(path);
        const start = options.byteOffset ?? 0;
        const end = Math.min(contents.byteLength, start + (options.byteLength ?? contents.byteLength));
        const selected = contents.slice(start, end);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(selected);
            controller.close();
          },
        });
      },
      async writeFile(path: string, contents: Uint8Array) {
        addParents(path);
        files.set(path, contents.slice());
      },
      async mkdir(path: string) {
        addParents(`${path}/placeholder`);
        directories.add(path);
      },
      async rm(path: string, options: { recursive?: boolean } = {}) {
        if (!files.has(path) && !directories.has(path)) throw missing(path);
        files.delete(path);
        directories.delete(path);
        if (!options.recursive) return;
        for (const candidate of files.keys()) {
          if (candidate.startsWith(`${path}/`)) files.delete(candidate);
        }
        for (const candidate of directories) {
          if (candidate.startsWith(`${path}/`)) directories.delete(candidate);
        }
      },
    },
  };
}
