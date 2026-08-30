import { describe, expect, it, vi } from "vitest";

import { createCloudflareSshCommand } from "../src/cloudflare-ssh";

describe("Cloudflare Just Bash SSH", () => {
  it("opens the requested direct TCP endpoint and closes a failed socket", async () => {
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(() => ({
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>(),
      opened: Promise.reject(new Error("test connection rejected")),
      closed: Promise.resolve(),
      close,
    }));
    const command = createCloudflareSshCommand({ connect, filesystem: () => emptyWorkspace() });

    await expect(command.execute([
      "-p", "2222", "-i", "id",
      "-o", "StrictHostKeyChecking=no",
      "worker@example.test", "--", "true",
    ], context())).resolves.toMatchObject({
      stderr: expect.stringContaining("not used"),
      exitCode: 255,
    });
    expect(connect).not.toHaveBeenCalled();

    const passwordCommand = createCloudflareSshCommand({
      connect,
      filesystem: () => emptyWorkspace(),
      async resolvePassword() { return "unused"; },
    });
    await expect(passwordCommand.execute([
      "-p", "2222", "-o", "PasswordRef=test",
      "-o", "StrictHostKeyChecking=no",
      "worker@example.test", "--", "true",
    ], context())).resolves.toEqual({
      stdout: "",
      stderr: "ssh: test connection rejected\n",
      exitCode: 255,
    });
    expect(connect).toHaveBeenCalledWith(
      { hostname: "example.test", port: 2222 },
      { allowHalfOpen: true, secureTransport: "off" },
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("delegates IdentityRef execution to private egress without receiving key bytes", async () => {
    const readFile = vi.fn();
    const connect = vi.fn();
    const egress = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://ssh.internal/v1/execute");
        expect(init?.headers).toEqual({
          "content-type": "application/json",
          "x-nanocodex-subject": "S".repeat(43),
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          identity_ref: "production",
          hostname: "ssh.example.com",
          port: 2222,
          username: "deploy",
          command: ["printf", "%s", "hello world"],
        });
        expect(String(init?.body)).not.toContain("PRIVATE KEY");
        return Response.json({ stdout: "hello world", stderr: "", exit_code: 0 });
      }),
    } as unknown as Fetcher;
    const command = createCloudflareSshCommand({
      connect,
      egress,
      filesystem: () => ({ ...emptyWorkspace(), readFile }),
      subject: "S".repeat(43),
    });

    await expect(command.execute([
      "-p", "2222", "-o", "IdentityRef=production",
      "deploy@ssh.example.com", "--", "printf", "%s", "hello world",
    ], context())).resolves.toEqual({ stdout: "hello world", stderr: "", exitCode: 0 });
    expect(readFile).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(egress.fetch).toHaveBeenCalledTimes(1);
  });

  it("reads direct identity files only from workspace paths", async () => {
    const readFile = vi.fn(async () => { throw new Error("identity read marker"); });
    const connect = vi.fn();
    const command = createCloudflareSshCommand({
      connect,
      filesystem: () => ({ ...emptyWorkspace(), readFile }),
    });

    await expect(command.execute([
      "-i", "/workspace/.ssh/id_ed25519",
      "-o", "StrictHostKeyChecking=no",
      "worker@example.test", "--", "true",
    ], context("/workspace/project"))).resolves.toMatchObject({
      stderr: "ssh: identity read marker\n",
      exitCode: 255,
    });
    expect(readFile).toHaveBeenCalledWith("/workspace/.ssh/id_ed25519");

    await expect(command.execute([
      "-i", "/tmp/id_ed25519",
      "-o", "StrictHostKeyChecking=no",
      "worker@example.test", "--", "true",
    ], context())).resolves.toMatchObject({
      stderr: "ssh: SSH identity path must stay within /workspace\n",
      exitCode: 255,
    });
  });
});

function context(cwd = "/workspace") {
  return { cwd, stdin: "", signal: new AbortController().signal };
}

function emptyWorkspace() {
  return {
    root: "/workspace",
    async list() { return []; },
    async readFile() { throw new Error("not used"); },
    async writeFile() {},
    async mkdir() {},
    async remove() {},
  };
}
