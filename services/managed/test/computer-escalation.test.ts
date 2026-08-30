import { describe, expect, it, vi } from "vitest";

import {
  createManagedComputerRuntime,
  isVirtualSafeCommand,
} from "../src/computer-runtime";
import { createSandboxComputerProvider } from "../src/computer-provider";

describe("managed Computer escalation", () => {
  it("starts virtual, promotes before unknown compute, then stays native", async () => {
    const computer = memoryComputer();
    const sandboxExec = vi.fn(async (command: string) => ({
      stdout: command === "cargo test"
        ? "running 1 test\ntest result: ok\n"
        : command === "cat marker"
          ? "native marker\n"
          : "",
      stderr: "",
      exitCode: 0,
    }));
    const sandbox = vi.fn(async () => ({ exec: sandboxExec }));
    const baseProvider = createSandboxComputerProvider({
      sandbox,
      workspace: computer.workspace,
    });
    const providerExec = vi.fn(baseProvider.exec);
    const runtime = await createManagedComputerRuntime({
      computer: computer.client,
      computerProvider: { exec: providerExec, dispose: baseProvider.dispose },
      egress: { fetch: vi.fn() } as unknown as Fetcher,
    });
    const context = {
      callId: "sticky-escalation",
      parentCallId: "",
      sessionId: "test",
      signal: new AbortController().signal,
    };

    expect(await runtime.tool.handler({
      cmd: "printf cheap > marker && cat marker",
    }, context)).toMatchObject({ exit_code: 0, output: "cheap" });
    expect(sandbox).not.toHaveBeenCalled();
    expect(providerExec).not.toHaveBeenCalled();

    await runtime.filesystem.writeFile("Cargo.toml", "[package]\nname='smoke'\nversion='0.1.0'\n");
    await runtime.filesystem.mkdir("src");
    await runtime.filesystem.writeFile("src/lib.rs", "#[test] fn smoke() { assert_eq!(2 + 2, 4); }\n");

    expect(await runtime.tool.handler({ cmd: "cargo test" }, context)).toMatchObject({
      exit_code: 0,
      output: "running 1 test\ntest result: ok\n",
    });
    expect(sandbox).toHaveBeenCalledTimes(1);
    expect(providerExec).toHaveBeenLastCalledWith({
      command: "cargo test",
      cwd: "/workspace",
      requirements: { capabilities: ["native-process"] },
    });

    // cat is normally a Just Bash command, but promotion is sticky for the runtime.
    expect(await runtime.tool.handler({ cmd: "cat marker" }, context)).toMatchObject({
      exit_code: 0,
      output: "native marker\n",
    });
    expect(providerExec).toHaveBeenLastCalledWith({
      command: "cat marker",
      cwd: "/workspace",
      requirements: { capabilities: ["native-process"] },
    });
    expect(providerExec).toHaveBeenCalledTimes(2);
    expect(runtime.commandNames).toEqual(["gh", "git"]);
    expect(runtime.instructions).not.toContain("sandbox escalation");

    runtime.dispose();
  });

  it("preflight checks the complete shell expression before allowing virtual execution", () => {
    const safe = new Set(["cat", "echo", "find", "grep", "printf"]);

    expect(isVirtualSafeCommand("printf cheap > marker && cat marker", safe)).toBe(true);
    expect(isVirtualSafeCommand("cat marker | grep cheap", safe)).toBe(true);
    expect(isVirtualSafeCommand("find . -type f", safe)).toBe(true);
    expect(isVirtualSafeCommand("VALUE=cheap printf $VALUE", safe)).toBe(true);

    expect(isVirtualSafeCommand("cargo test", safe)).toBe(false);
    expect(isVirtualSafeCommand("cat marker | cargo test", safe)).toBe(false);
    expect(isVirtualSafeCommand("echo $(cargo metadata)", safe)).toBe(false);
    expect(isVirtualSafeCommand("find . -exec cargo test \\;", safe)).toBe(false);
    expect(isVirtualSafeCommand("env cargo test", safe)).toBe(false);
    expect(isVirtualSafeCommand("./script.sh", safe)).toBe(false);
  });

  it("projects exact durable state once and preserves the retained native workspace", async () => {
    const files = new Map([
      ["/workspace/Cargo.toml", new TextEncoder().encode("[package]\nname='smoke'\nversion='0.1.0'\n")],
      ["/workspace/src/lib.rs", new TextEncoder().encode("pub fn answer() -> u8 { 42 }\n")],
      ["/workspace/blob.bin", Uint8Array.from([0, 255, 128, 1])],
    ]);
    const workspace = {
      root: "/workspace",
      list: vi.fn(async () => [
        { kind: "file" as const, path: "/workspace/Cargo.toml", size: files.get("/workspace/Cargo.toml")!.byteLength },
        { kind: "directory" as const, path: "/workspace/src" },
        { kind: "file" as const, path: "/workspace/src/lib.rs", size: files.get("/workspace/src/lib.rs")!.byteLength },
        { kind: "file" as const, path: "/workspace/blob.bin", size: files.get("/workspace/blob.bin")!.byteLength },
      ]),
      readFile: vi.fn(async (path: string) => files.get(path)!),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      remove: vi.fn(),
    };
    const exec = vi.fn(async (command: string) => ({
      stdout: command === "cargo test" ? "ok\n" : "",
      stderr: "",
      exitCode: 0,
    }));
    const create = vi.fn(async () => ({ exec }));
    const provider = createSandboxComputerProvider({ sandbox: create, workspace });

    await provider.exec({
      command: "cargo test",
      cwd: "/workspace",
      requirements: { capabilities: ["native-process"] },
    });
    await provider.exec({
      command: "printf generated > generated.txt",
      cwd: "/workspace",
      requirements: { capabilities: ["native-process"] },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls.filter(([command]) => command.includes("find '/workspace'")).length).toBe(1);
    expect(exec).toHaveBeenCalledWith(
      "printf %s 'AP+AAQ==' | base64 -d >> '/workspace/blob.bin'",
      { cwd: "/", timeout: 120_000 },
    );
    expect(exec).toHaveBeenCalledWith("printf generated > generated.txt", {
      cwd: "/workspace",
      timeout: 120_000,
    });
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
  const parents = (path: string) => {
    const parts = path.split("/").slice(1, -1);
    let current = "";
    for (const part of parts) { current += `/${part}`; directories.add(current); }
  };
  const fs = {
    async lstat(path: string) {
      if (files.has(path)) return stat("file", files.get(path)!.byteLength);
      if (directories.has(path)) return stat("directory");
      throw missing(path);
    },
    async readdir(path: string) {
      if (!directories.has(path)) throw missing(path);
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const candidate of [...directories, ...files.keys()]) {
        if (candidate.startsWith(prefix)) {
          const name = candidate.slice(prefix.length).split("/")[0];
          if (name) names.add(name);
        }
      }
      return [...names].sort().map((name) => {
        const candidate = `${prefix}${name}`;
        return { name, mtime: 1, ...(files.has(candidate)
          ? stat("file", files.get(candidate)!.byteLength)
          : stat("directory")) };
      });
    },
    async readFile(path: string) {
      const value = files.get(path);
      if (!value) throw missing(path);
      return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(value); controller.close(); } });
    },
    async writeFile(path: string, value: Uint8Array) { parents(path); files.set(path, value.slice()); },
    async mkdir(path: string) { parents(`${path}/x`); directories.add(path); },
    async rm(path: string) { files.delete(path); directories.delete(path); },
  };
  const client = { fs, [Symbol.dispose]: dispose };
  const workspace = {
    root: "/workspace",
    async list(path = ".", options: { recursive?: boolean } = {}) {
      const prefix = path === "." ? "/workspace/" : `${path}/`;
      const directoryEntries = [...directories]
        .filter((p) => p !== "/workspace")
        .map((p) => ({ kind: "directory" as const, path: p }));
      const fileEntries = [...files].map(([p, b]) => ({
        kind: "file" as const,
        path: p,
        size: b.byteLength,
      }));
      return [...directoryEntries, ...fileEntries]
        .filter((entry) => options.recursive || !entry.path.slice(prefix.length).includes("/"));
    },
    async readFile(path: string) { return files.get(path.startsWith("/") ? path : `/workspace/${path}`)!; },
    async writeFile(path: string, value: string | Uint8Array) {
      const target = path.startsWith("/") ? path : `/workspace/${path}`;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      parents(target); files.set(target, bytes);
    },
    async mkdir(path: string) { directories.add(path.startsWith("/") ? path : `/workspace/${path}`); },
    async remove(path: string) { files.delete(path); },
  };
  return { client, workspace };
}
