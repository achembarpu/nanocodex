import type { Workspace } from "nanocodex/workspace";

import { createIxSdkComputerProvider } from "./computer-provider-ix";

type Env = Readonly<{
  IX_TOKEN: string;
  IX_REGION?: string;
}>;

/**
 * Standalone smoke Worker: Cloudflare Worker -> ix SDK -> real ix VM -> cargo
 * test. `IX_TOKEN` is a Worker secret. The base ix image is intentionally kept
 * generic, so the smoke obtains Rust through a one-shot Nix shell rather than
 * depending on a Nanocodex-specific ix image.
 */
export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    if (!env.IX_TOKEN) {
      return Response.json({ error: "IX_TOKEN Worker secret is required" }, { status: 503 });
    }
    const provider = createIxSdkComputerProvider({
      ...(env.IX_REGION === undefined ? {} : { region: env.IX_REGION }),
      workspace: rustFixture(),
    });
    const started = Date.now();
    try {
      const result = await provider.exec({
        command: "nix shell nixpkgs#cargo nixpkgs#rustc -c cargo test",
        cwd: "/workspace",
        requirements: { capabilities: ["native-process"] },
        timeoutMs: 120_000,
      });
      return Response.json({
        provider: "ix",
        requested_capabilities: ["native-process"],
        duration_ms: Date.now() - started,
        ...result,
      }, { status: result.exitCode === 0 ? 200 : 500 });
    } finally {
      await provider.dispose?.();
    }
  },
};

function rustFixture(): Workspace {
  const files = new Map<string, Uint8Array>([
    ["/workspace/Cargo.toml", encode([
      "[package]",
      "name = \"nanocodex-ix-compute-smoke\"",
      "version = \"0.1.0\"",
      "edition = \"2021\"",
      "",
      "[lib]",
      "path = \"lib.rs\"",
      "",
    ].join("\n"))],
    ["/workspace/lib.rs", encode("#[test] fn ix_compute_works() { assert_eq!(20 + 22, 42); }\n")],
  ]);
  return Object.freeze({
    root: "/workspace",
    async list() {
      return [...files].map(([path, contents]) => Object.freeze({
        kind: "file" as const,
        path,
        size: contents.byteLength,
      }));
    },
    async readFile(path) {
      const contents = files.get(path);
      if (!contents) throw new Error(`missing ix smoke fixture: ${path}`);
      return contents;
    },
    async writeFile(path, contents) {
      files.set(path, typeof contents === "string" ? encode(contents) : new Uint8Array(contents));
    },
    async mkdir() {},
    async remove(path) { files.delete(path); },
  });
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
