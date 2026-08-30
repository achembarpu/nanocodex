import type { Sandbox } from "@cloudflare/sandbox";
import type { Workspace } from "nanocodex/workspace";

import { createCloudflareSandboxComputerProvider } from "./computer-provider";

export { Sandbox } from "@cloudflare/sandbox";

type Env = Readonly<{
  NANOCODEX_COMPUTE_SANDBOX: DurableObjectNamespace<Sandbox>;
}>;

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const id = crypto.randomUUID();
    const provider = createCloudflareSandboxComputerProvider({
      namespace: env.NANOCODEX_COMPUTE_SANDBOX,
      sessionId: id,
      workspace: rustFixture(),
    });
    const started = Date.now();
    try {
      const result = await provider.exec({
        command: "CARGO_TARGET_DIR=/tmp/nanocodex-target cargo test",
        cwd: "/workspace",
        requirements: { capabilities: ["native-process"] },
        timeoutMs: 120_000,
      });
      return Response.json({
        provider: "cloudflare-sandbox",
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
      "name = \"nanocodex-compute-smoke\"",
      "version = \"0.1.0\"",
      "edition = \"2021\"",
      "",
      "[lib]",
      "path = \"lib.rs\"",
      "",
    ].join("\n"))],
    ["/workspace/lib.rs", encode("#[test] fn escalated_compute_works() { assert_eq!(2 + 2, 4); }\n")],
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
      if (!contents) throw new Error(`missing smoke fixture: ${path}`);
      return contents;
    },
    async writeFile(path, contents) {
      files.set(path, typeof contents === "string" ? encode(contents) : copyBytes(contents));
    },
    async mkdir() {},
    async remove(path) { files.delete(path); },
  });
}

function copyBytes(value: ArrayBuffer | ArrayBufferView<ArrayBufferLike>): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
