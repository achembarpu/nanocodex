import type { Client } from "@indexable/sdk";
import { describe, expect, it, vi } from "vitest";

import { createIxSdkComputerProvider } from "../src/computer-provider-ix";

describe("managed ix SDK provider", () => {
  it("creates lazily through Client.machines and explicitly deletes and closes", async () => {
    const workspace = fixtureWorkspace();
    const remove = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const exec = vi.fn(async (argv: string[]) => ({
      stdout: argv[2]?.includes("cargo") ? "ix sdk cargo ok\n" : "",
      stderr: "",
      exitCode: 0,
    }));
    const create = vi.fn(async () => ({
      close,
      delete: remove,
      exec,
      writeFile,
    }));
    const client = {
      machines: () => ({ create }),
    } as unknown as Client;
    const provider = createIxSdkComputerProvider({
      client,
      name: "nanocodex-thread-sdk",
      region: "us-west-1",
      workspace,
    });

    expect(create).not.toHaveBeenCalled();
    expect(await provider.exec({
      command: "'cargo' 'test'",
      cwd: "/workspace",
      requirements: { capabilities: ["native-process"] },
    })).toEqual({
      stdout: "ix sdk cargo ok\n",
      stderr: "",
      exitCode: 0,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      name: "nanocodex-thread-sdk",
      region: "us-west-1",
    });
    expect(writeFile).toHaveBeenCalledWith(
      "/workspace/Cargo.toml",
      expect.any(Uint8Array),
    );

    await provider.dispose?.();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
  });
});

function fixtureWorkspace() {
  const cargo = new TextEncoder().encode([
    "[package]",
    "name = \"nanocodex-ix-sdk-smoke\"",
    "version = \"0.1.0\"",
    "edition = \"2024\"",
    "",
    "[lib]",
    "path = \"lib.rs\"",
    "",
  ].join("\n"));
  const lib = new TextEncoder().encode("#[test] fn works() { assert_eq!(6 * 7, 42); }\n");
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
