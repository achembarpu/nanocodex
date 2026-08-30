import { describe, expect, it, vi } from "vitest";

import { createIxBrokerComputerProvider } from "../src/computer-provider-ix";

describe("managed ix broker provider", () => {
  it("allocates lazily, projects the workspace, executes, and deletes by machine id", async () => {
    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method, url, body });

      if (method === "POST" && url.endsWith("/v1/machines")) {
        return Response.json({ id: "ix-machine-1" }, { status: 201 });
      }
      if (method === "PUT" && url.endsWith("/files")) {
        return Response.json({});
      }
      if (method === "POST" && url.endsWith("/exec")) {
        const argv = (body as { argv?: string[] } | undefined)?.argv ?? [];
        const command = argv.join(" ");
        return Response.json({
          stdout: command.includes("cargo") ? "ix cargo ok\n" : "",
          stderr: "",
          exitCode: 0,
        });
      }
      if (method === "DELETE" && url.endsWith("/ix-machine-1")) {
        return Response.json({});
      }
      return new Response("unexpected ix broker request", { status: 500 });
    });

    const provider = createIxBrokerComputerProvider({
      brokerToken: "broker-secret",
      brokerUrl: "https://ix-broker.example.test/",
      fetch: request as unknown as typeof fetch,
      name: "nanocodex-thread-1",
      region: "us-west-1",
      workspace: fixtureWorkspace(),
    });

    expect(request).not.toHaveBeenCalled();
    expect(await provider.exec({
      command: "'cargo' 'test'",
      cwd: "/workspace",
      requirements: { capabilities: ["native-process"] },
    })).toEqual({
      stdout: "ix cargo ok\n",
      stderr: "",
      exitCode: 0,
    });

    expect(requests[0]).toEqual({
      method: "POST",
      url: "https://ix-broker.example.test/v1/machines",
      body: { name: "nanocodex-thread-1", region: "us-west-1" },
    });
    expect(requests).toContainEqual(expect.objectContaining({
      method: "PUT",
      url: "https://ix-broker.example.test/v1/machines/ix-machine-1/files",
    }));
    expect(requests.some(({ body, method, url }) =>
      method === "POST"
      && url.endsWith("/ix-machine-1/exec")
      && JSON.stringify(body).includes("cargo"))).toBe(true);

    await provider.dispose?.();
    expect(requests.at(-1)).toEqual({
      method: "DELETE",
      url: "https://ix-broker.example.test/v1/machines/ix-machine-1",
      body: undefined,
    });
  });
});

function fixtureWorkspace() {
  const cargo = new TextEncoder().encode([
    "[package]",
    "name = \"nanocodex-ix-broker-smoke\"",
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
