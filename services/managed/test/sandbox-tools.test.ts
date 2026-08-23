import { describe, expect, it, vi } from "vitest";

import {
  cloudflareSandboxPreviewUrl,
  createCloudflareSandboxTools,
  openSandboxPreviewCapability,
  workspacePath,
} from "../src/sandbox-tools";

const MIB = 1024 * 1024;
const OUTPUT_LIMIT = 128 * 1024;
const context = {
  callId: "call",
  parentCallId: "parent",
  sessionId: "session",
  signal: new AbortController().signal,
};

describe("Cloudflare sandbox workspace paths", () => {
  it("canonicalizes paths under the virtual workspace", () => {
    expect(workspacePath(".")).toBe("/workspace");
    expect(workspacePath("././")).toBe("/workspace");
    expect(workspacePath("src//./index.ts")).toBe("/workspace/src/index.ts");
    expect(workspacePath("/workspace")).toBe("/workspace");
    expect(workspacePath("/workspace//out.txt")).toBe("/workspace/out.txt");
    expect(workspacePath("file..txt")).toBe("/workspace/file..txt");
  });

  it.each([
    "",
    "../secret",
    "safe/../../secret",
    "/workspace/../secret",
    "/workspace2/secret",
    "/etc/passwd",
    "nul\0byte",
    "x".repeat(1025),
  ])("rejects an invalid or escaping path: %s", (path) => {
    expect(() => workspacePath(path)).toThrow();
  });
});

describe("Cloudflare sandbox preview URLs", () => {
  it("seals the session and port in a same-origin capability route", async () => {
    const sessionId = "019fc927-b280-79a7-8445-1b9996ad2fb0";
    const url = await cloudflareSandboxPreviewUrl(
      "https://agent.example",
      "preview-secret",
      sessionId,
      8080,
    );
    expect(url).toMatch(/^https:\/\/agent\.example\/sandbox-preview\/[A-Za-z0-9_-]+\/$/);
    expect(url).not.toContain(sessionId);
    const capability = new URL(url).pathname.split("/")[2]!;
    await expect(openSandboxPreviewCapability("preview-secret", capability)).resolves.toEqual({
      sessionId,
      port: 8080,
    });
    await expect(openSandboxPreviewCapability("wrong-secret", capability)).rejects.toThrow(
      "invalid preview capability",
    );
  });

  it.each([
    "ftp://agent.example",
    "https://user:secret@agent.example",
    "https://agent.example/path",
    "https://agent.example/?query=true",
  ])("rejects a non-origin preview base: %s", async (origin) => {
    await expect(cloudflareSandboxPreviewUrl(
      origin,
      "preview-secret",
      "session-id",
      8080,
    )).rejects.toThrow(
      "public origin must be an HTTP(S) origin",
    );
  });
});

describe("Cloudflare sandbox tools", () => {
  it("rejects malformed tool inputs before creating a sandbox", async () => {
    const sandbox = makeSandbox();
    const factory = vi.fn(async () => sandbox);
    const tools = createCloudflareSandboxTools(factory);

    for (const input of [null, undefined, [], "command", 1, true]) {
      await expect(invoke(tools, "sandbox_exec", input)).rejects.toThrow("tool input must be an object");
    }
    await expect(invoke(tools, "sandbox_exec", {})).rejects.toThrow("command must be a non-empty string");
    await expect(invoke(tools, "sandbox_exec", { command: "" })).rejects.toThrow("command must be a non-empty string");
    await expect(invoke(tools, "sandbox_exec", { command: "x".repeat(32 * 1024 + 1) })).rejects.toThrow("command is too long");
    await expect(invoke(tools, "sandbox_exec", { command: "pwd", cwd: "../outside" })).rejects.toThrow("must not contain");
    expect(factory).not.toHaveBeenCalled();
  });

  it("passes bounded exec options through and reports non-zero results", async () => {
    const sandbox = makeSandbox({
      exec: vi.fn(async () => ({
        success: false,
        exitCode: 7,
        stdout: "partial",
        stderr: "failed",
        duration: 42,
      })),
    });
    const tools = createCloudflareSandboxTools(async () => sandbox);

    const defaultResult = await invoke(tools, "sandbox_exec", { command: "false" });
    expect(sandbox.exec).toHaveBeenNthCalledWith(1, "false", {
      cwd: "/workspace",
      timeout: 60_000,
    });
    expect(defaultResult).toEqual({
      success: false,
      exit_code: 7,
      stdout: "partial",
      stderr: "failed",
      stdout_truncated: false,
      stderr_truncated: false,
      duration_ms: 42,
    });

    await invoke(tools, "sandbox_exec", {
      command: "pwd",
      cwd: "/workspace/src",
      timeout_ms: 120_000,
    });
    expect(sandbox.exec).toHaveBeenNthCalledWith(2, "pwd", {
      cwd: "/workspace/src",
      timeout: 120_000,
    });
  });

  it.each([0, 120_001, 1.5, "1000", null, Number.NaN])(
    "rejects an invalid exec timeout: %s",
    async (timeout) => {
      const sandbox = makeSandbox();
      const tools = createCloudflareSandboxTools(async () => sandbox);
      await expect(invoke(tools, "sandbox_exec", {
        command: "pwd",
        timeout_ms: timeout,
      })).rejects.toThrow("timeout_ms must be an integer");
      expect(sandbox.exec).not.toHaveBeenCalled();
    },
  );

  it("caps stdout and stderr by UTF-8 bytes without splitting code points", async () => {
    const sandbox = makeSandbox({
      exec: vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: "é".repeat(OUTPUT_LIMIT),
        stderr: "x".repeat(OUTPUT_LIMIT + 1),
        duration: 1,
      })),
    });
    const result = await invoke(
      createCloudflareSandboxTools(async () => sandbox),
      "sandbox_exec",
      { command: "produce-output" },
    );

    expect(new TextEncoder().encode(result.stdout).byteLength).toBe(OUTPUT_LIMIT);
    expect(result.stdout.endsWith("é")).toBe(true);
    expect(result.stderr).toHaveLength(OUTPUT_LIMIT);
    expect(result.stdout_truncated).toBe(true);
    expect(result.stderr_truncated).toBe(true);
  });

  it("writes empty and exactly-1-MiB files and counts UTF-8 bytes", async () => {
    const sandbox = makeSandbox();
    const tools = createCloudflareSandboxTools(async () => sandbox);

    await expect(invoke(tools, "sandbox_write_file", {
      path: "empty.txt",
      content: "",
    })).resolves.toEqual({ path: "/workspace/empty.txt", bytes_written: 0 });
    const exact = "😀".repeat(MIB / 4);
    await expect(invoke(tools, "sandbox_write_file", {
      path: "unicode.txt",
      content: exact,
    })).resolves.toEqual({ path: "/workspace/unicode.txt", bytes_written: MIB });
    expect(sandbox.writeFile).toHaveBeenLastCalledWith(
      "/workspace/unicode.txt",
      exact,
      { encoding: "utf-8" },
    );
  });

  it("rejects oversized and malformed writes before entering the sandbox", async () => {
    const sandbox = makeSandbox();
    const tools = createCloudflareSandboxTools(async () => sandbox);

    await expect(invoke(tools, "sandbox_write_file", {
      path: "large.txt",
      content: "😀".repeat(MIB / 4 + 1),
    })).rejects.toThrow("content exceeds 1 MiB");
    await expect(invoke(tools, "sandbox_write_file", {
      path: "bad.txt",
      content: 123,
    })).rejects.toThrow("content must be a string");
    await expect(invoke(tools, "sandbox_write_file", {
      path: "../bad.txt",
      content: "x",
    })).rejects.toThrow("must not contain");
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("assembles a bounded multichunk UTF-8 read", async () => {
    const bytes = new TextEncoder().encode("left 😀 right");
    const sandbox = makeSandbox({
      readFile: vi.fn(async () => ({
        size: bytes.byteLength,
        content: byteStream(bytes.subarray(0, 7), bytes.subarray(7, 9), bytes.subarray(9)),
      })),
    });
    const tools = createCloudflareSandboxTools(async () => sandbox);

    await expect(invoke(tools, "sandbox_read_file", { path: "message.txt" })).resolves.toEqual({
      path: "/workspace/message.txt",
      content: "left 😀 right",
    });
    expect(sandbox.readFile).toHaveBeenCalledWith("/workspace/message.txt", { encoding: "none" });
  });

  it("rejects oversized read metadata without consuming the stream", async () => {
    let pulled = false;
    const content = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1]));
      },
    }, { highWaterMark: 0 });
    const sandbox = makeSandbox({ readFile: vi.fn(async () => ({ size: MIB + 1, content })) });

    await expect(invoke(
      createCloudflareSandboxTools(async () => sandbox),
      "sandbox_read_file",
      { path: "large.txt" },
    )).rejects.toThrow("file exceeds 1 MiB");
    expect(pulled).toBe(false);
  });

  it("cancels a lying stream that crosses the read limit", async () => {
    let cancelReason: unknown;
    const chunks = [new Uint8Array(700_000), new Uint8Array(400_000)];
    const content = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel(reason) {
        cancelReason = reason;
      },
    }, { highWaterMark: 0 });
    const sandbox = makeSandbox({ readFile: vi.fn(async () => ({ size: 0, content })) });

    await expect(invoke(
      createCloudflareSandboxTools(async () => sandbox),
      "sandbox_read_file",
      { path: "lying.txt" },
    )).rejects.toThrow("file exceeds 1 MiB");
    expect(cancelReason).toBe("file exceeds 1 MiB");
  });

  it("rejects invalid UTF-8 instead of silently replacing bytes", async () => {
    const content = byteStream(new Uint8Array([0xc3, 0x28]));
    const sandbox = makeSandbox({ readFile: vi.fn(async () => ({ size: 2, content })) });

    await expect(invoke(
      createCloudflareSandboxTools(async () => sandbox),
      "sandbox_read_file",
      { path: "binary.dat" },
    )).rejects.toThrow("file is not valid UTF-8");
  });

  it("includes hidden entries, caps directory results, and exposes previews", async () => {
    const files = Array.from({ length: 513 }, (_, index) => ({
      name: index === 0 ? ".hidden" : `file-${index}`,
      type: index % 2 === 0 ? "file" : "directory",
      size: index,
    }));
    const sandbox = makeSandbox({
      listFiles: vi.fn(async () => ({ files })),
      tunnels: { get: vi.fn(async () => ({ url: "https://preview.example" })) },
    });
    const tools = createCloudflareSandboxTools(async () => sandbox);

    const listed = await invoke(tools, "sandbox_list_files", {});
    expect(sandbox.listFiles).toHaveBeenCalledWith("/workspace", { includeHidden: true });
    expect(listed.entries).toHaveLength(512);
    expect(listed.entries[0]).toEqual({ name: ".hidden", type: "file", size: 0 });
    expect(listed.truncated).toBe(true);

    await expect(invoke(tools, "sandbox_preview", { port: 65_535 })).resolves.toEqual({
      port: 65_535,
      url: "https://preview.example",
      persistent: false,
    });
    expect(sandbox.tunnels.get).toHaveBeenCalledWith(65_535);
  });

  it("starts a managed process and optionally waits for port readiness", async () => {
    const process = {
      id: "process-1",
      pid: 42,
      command: "node server.js",
      status: "starting",
      getStatus: vi.fn(async () => "running"),
      waitForPort: vi.fn(async () => {}),
    };
    const sandbox = makeSandbox({ startProcess: vi.fn(async () => process) });
    const tools = createCloudflareSandboxTools(async () => sandbox);

    await expect(invoke(tools, "sandbox_start_process", {
      command: "node server.js",
      cwd: "app",
      ready_port: 8080,
      ready_timeout_ms: 12_345,
    })).resolves.toEqual({
      process_id: "process-1",
      pid: 42,
      command: "node server.js",
      status: "running",
      ready_port: 8080,
    });
    expect(sandbox.startProcess).toHaveBeenCalledWith("node server.js", {
      cwd: "/workspace/app",
      autoCleanup: true,
    });
    expect(process.waitForPort).toHaveBeenCalledWith(8080, { timeout: 12_345 });
  });

  it("uses a Worker-fronted preview provider after initializing the sandbox", async () => {
    const sandbox = makeSandbox();
    const factory = vi.fn(async () => sandbox);
    const preview = vi.fn(async (port: number) => ({
      port,
      url: `https://agent.example/sandbox-preview/session/${port}/`,
      persistent: false,
    }));
    const tools = createCloudflareSandboxTools(factory, preview);

    await expect(invoke(tools, "sandbox_preview", { port: 8080 })).resolves.toEqual({
      port: 8080,
      url: "https://agent.example/sandbox-preview/session/8080/",
      persistent: false,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith(8080);
    expect(sandbox.tunnels.get).not.toHaveBeenCalled();
  });

  it("rejects invalid managed-process inputs before starting anything", async () => {
    const sandbox = makeSandbox();
    const tools = createCloudflareSandboxTools(async () => sandbox);
    await expect(invoke(tools, "sandbox_start_process", {
      command: "node server.js",
      ready_port: 80,
    })).rejects.toThrow("ready_port must be an integer");
    await expect(invoke(tools, "sandbox_start_process", {
      command: "node server.js",
      ready_timeout_ms: 0,
    })).rejects.toThrow("ready_timeout_ms must be an integer");
    expect(sandbox.startProcess).not.toHaveBeenCalled();
  });

  it.each([undefined, 1023, 65_536, 3000.5, "3000", null])(
    "rejects an invalid preview port: %s",
    async (port) => {
      const sandbox = makeSandbox();
      await expect(invoke(
        createCloudflareSandboxTools(async () => sandbox),
        "sandbox_preview",
        { port },
      )).rejects.toThrow(port === undefined ? "port is required" : "port must be an integer");
      expect(sandbox.tunnels.get).not.toHaveBeenCalled();
    },
  );

  it("lazily initializes one sandbox and caches initialization failures", async () => {
    const sandbox = makeSandbox();
    const factory = vi.fn(async () => sandbox);
    const tools = createCloudflareSandboxTools(factory);
    await invoke(tools, "sandbox_exec", { command: "pwd" });
    await invoke(tools, "sandbox_write_file", { path: "one", content: "1" });
    expect(factory).toHaveBeenCalledTimes(1);

    const failure = new Error("container unavailable");
    const failingFactory = vi.fn(async () => { throw failure; });
    const failingTools = createCloudflareSandboxTools(failingFactory);
    await expect(invoke(failingTools, "sandbox_exec", { command: "pwd" })).rejects.toBe(failure);
    await expect(invoke(failingTools, "sandbox_list_files", {})).rejects.toBe(failure);
    expect(failingFactory).toHaveBeenCalledTimes(1);
  });
});

function makeSandbox(overrides: Record<string, unknown> = {}) {
  return {
    exec: vi.fn(async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      duration: 1,
    })),
    startProcess: vi.fn(async (command: string) => ({
      id: "process",
      pid: 1,
      command,
      status: "running",
      getStatus: vi.fn(async () => "running"),
      waitForPort: vi.fn(async () => {}),
    })),
    readFile: vi.fn(async () => ({
      size: 5,
      content: byteStream(new TextEncoder().encode("hello")),
    })),
    writeFile: vi.fn(async () => ({})),
    listFiles: vi.fn(async () => ({ files: [] })),
    tunnels: { get: vi.fn(async () => ({ url: "https://preview.example" })) },
    ...overrides,
  };
}

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function invoke(
  tools: ReturnType<typeof createCloudflareSandboxTools>,
  name: string,
  input: unknown,
): Promise<any> {
  const tool = tools[name];
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool.handler(input, context);
}
