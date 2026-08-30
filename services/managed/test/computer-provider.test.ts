import { describe, expect, it, vi } from "vitest";

import {
  createExeComputerProvider,
  createIxComputerProvider,
  createVercelSandboxComputerProvider,
} from "../src/computer-provider";

describe("managed computer providers", () => {
  it("adapts Vercel Sandbox without creating it before native execution", async () => {
    const workspace = fixtureWorkspace();
    const writeFiles = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const runCommand = vi.fn(async (input: { cmd: string; args: string[]; cwd?: string }) => ({
      exitCode: 0,
      stdout: async () => input.args[1]?.includes("cargo") ? "vercel cargo ok\n" : "",
      stderr: async () => "",
    }));
    const createSandbox = vi.fn(async () => ({ runCommand, stop, writeFiles }));
    const provider = createVercelSandboxComputerProvider({ createSandbox, workspace });

    expect(createSandbox).not.toHaveBeenCalled();
    expect(await cargo(provider)).toEqual({
      stdout: "vercel cargo ok\n",
      stderr: "",
      exitCode: 0,
    });
    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(writeFiles).toHaveBeenCalledWith([
      { path: "/workspace/Cargo.toml", content: expect.any(Uint8Array) },
    ]);
    expect(runCommand).toHaveBeenCalledWith({
      cmd: "bash",
      args: ["-lc", "'cargo' 'test'"],
      cwd: "/workspace",
    });

    await provider.dispose?.();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("adapts ix machines and deletes the retained machine on disposal", async () => {
    const workspace = fixtureWorkspace();
    const writeFile = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const exec = vi.fn(async (argv: string[]) => ({
      stdout: argv[2]?.includes("cargo") ? "ix cargo ok\n" : "",
      stderr: "",
      exitCode: 0,
    }));
    const createMachine = vi.fn(async () => ({
      exec,
      writeFile,
      delete: remove,
    }));
    const provider = createIxComputerProvider({ createMachine, workspace });

    expect(await cargo(provider)).toEqual({
      stdout: "ix cargo ok\n",
      stderr: "",
      exitCode: 0,
    });
    expect(createMachine).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(
      "/workspace/Cargo.toml",
      expect.any(Uint8Array),
    );
    expect(exec).toHaveBeenCalledWith([
      "bash",
      "-lc",
      "cd '/workspace' && exec 'cargo' 'test'",
    ]);

    await provider.dispose?.();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("uses exe.dev's HTTPS SSH API without installing a Nanocodex worker", async () => {
    const workspace = fixtureWorkspace();
    const commands: string[] = [];
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const command = String(init?.body ?? "");
      commands.push(command);
      const payload = command.startsWith("ssh ") && command.includes("cargo")
        ? { stdout: "exe cargo ok\n", stderr: "", exit_code: 0 }
        : command.startsWith("ssh ")
          ? { stdout: "", stderr: "", exit_code: 0 }
          : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = createExeComputerProvider({
      fetch: request as typeof fetch,
      name: "nanocodex-test",
      token: "exe1.test",
      workspace,
    });

    expect(await cargo(provider)).toEqual({
      stdout: "exe cargo ok\n",
      stderr: "",
      exitCode: 0,
    });
    expect(commands[0]).toBe("new --name=nanocodex-test --image=exeuntu");
    expect(commands.some((command) => command.includes("base64 -d >> '/workspace/Cargo.toml'")))
      .toBe(true);
    expect(commands.some((command) => command.includes("exec '\\''cargo'\\'' '\\''test'\\''")))
      .toBe(true);

    await provider.dispose?.();
    expect(commands.at(-1)).toBe("rm nanocodex-test");
  });
});

async function cargo(provider: {
  exec(input: {
    command: string;
    cwd: string;
    requirements: { capabilities: readonly ["native-process"] };
  }): Promise<unknown>;
}) {
  return provider.exec({
    command: "'cargo' 'test'",
    cwd: "/workspace",
    requirements: { capabilities: ["native-process"] },
  });
}

function fixtureWorkspace() {
  const cargo = new TextEncoder().encode([
    "[package]",
    "name = \"nanocodex-compute-smoke\"",
    "version = \"0.1.0\"",
    "edition = \"2024\"",
    "",
    "[lib]",
    "path = \"lib.rs\"",
    "",
  ].join("\n"));
  const lib = new TextEncoder().encode("#[test] fn works() { assert_eq!(2 + 2, 4); }\n");
  return {
    root: "/workspace",
    async list() {
      return [
        { kind: "file" as const, path: "/workspace/Cargo.toml", size: cargo.byteLength },
        { kind: "file" as const, path: "/workspace/lib.rs", size: lib.byteLength },
      ];
    },
    async readFile(path: string) {
      if (path.endsWith("Cargo.toml")) return cargo;
      if (path.endsWith("lib.rs")) return lib;
      throw new Error(`missing fixture file: ${path}`);
    },
    async writeFile() {},
    async mkdir() {},
    async remove() {},
  };
}
