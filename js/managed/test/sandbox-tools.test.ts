import { beforeEach, describe, expect, it, vi } from "vitest";

const sandboxSdk = vi.hoisted(() => ({ getSandbox: vi.fn() }));

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: sandboxSdk.getSandbox }));

import {
  cloudflareSandboxTools,
  createCloudflareSandboxTools,
  deleteCloudflareSandboxWorkspace,
} from "../src/sandbox-tools";
import type { Sandbox } from "../src/sandbox-runtime";

const context = {
  callId: "call",
  model: "gpt-5.6-sol",
  parentCallId: "parent",
  sessionId: "session",
  signal: new AbortController().signal,
};

describe("Cloudflare sandbox tools", () => {
  beforeEach(() => sandboxSdk.getSandbox.mockReset());

  it("creates one sandbox lazily across explicit tool calls", async () => {
    const sandbox = fakeSandbox();
    const create = vi.fn(async () => sandbox);
    const tools = createCloudflareSandboxTools(create);

    await tools.sandbox_exec!.handler({ command: "uname -a" }, context);
    await tools.sandbox_write_file!.handler({ path: "proof.txt", content: "ok" }, context);

    expect(create).toHaveBeenCalledTimes(1);
    expect(sandbox.exec).toHaveBeenCalledWith("uname -a", {
      cwd: "/workspace",
    });
  });

  it("prepares one shared sandbox once across concurrent parent and child tool sets", async () => {
    const namespace = fakeNamespace();
    const sandbox = preparingSandbox("empty");
    sandboxSdk.getSandbox.mockReturnValue(sandbox);
    const parent = cloudflareSandboxTools(namespace, "shared-session");
    const child = cloudflareSandboxTools(namespace, "shared-session");

    await Promise.all([
      parent.sandbox_exec!.handler({ command: "printf parent" }, context),
      child.sandbox_exec!.handler({ command: "printf child" }, {
        ...context,
        sessionId: "child-session",
        subagent: {
          agentId: "1",
          parentAgentId: null,
          sessionId: "child-session",
          role: "worker",
          task: "exercise the shared sandbox",
        },
      }),
    ]);

    expect(sandboxSdk.getSandbox).toHaveBeenCalledTimes(1);
    expect(sandbox.mountBucket).toHaveBeenCalledTimes(1);
    expect(sandbox.mountBucket).toHaveBeenCalledWith(
      "NANOCODEX_WORKSPACES",
      "/workspace",
      { prefix: "/sessions/shared-session/" },
    );
  });

  it("reuses a healthy retained workspace after the managed host reconnects", async () => {
    const sandbox = preparingSandbox("empty");
    sandboxSdk.getSandbox.mockReturnValue(sandbox);

    await cloudflareSandboxTools(fakeNamespace(), "retained-session")
      .sandbox_exec!.handler({ command: "printf first" }, context);
    await cloudflareSandboxTools(fakeNamespace(), "retained-session")
      .sandbox_exec!.handler({ command: "printf reconnected" }, context);

    expect(sandbox.mountBucket).toHaveBeenCalledTimes(1);
    expect(sandbox.exec.mock.calls.filter(([command]) => isMountProbe(command))).toHaveLength(3);
  });

  it("accepts a concurrent mount winner only after the retained mount probes healthy", async () => {
    const namespace = fakeNamespace();
    const sandbox = preparingSandbox("empty");
    const mountError = new Error("S3FS mount failed: MOUNTPOINT directory /workspace is not empty");
    sandbox.mountBucket.mockImplementationOnce(async () => {
      sandbox.setMountState("mounted");
      throw mountError;
    });
    sandboxSdk.getSandbox.mockReturnValue(sandbox);

    await expect(cloudflareSandboxTools(namespace, "raced-session")
      .sandbox_exec!.handler({ command: "printf reused" }, context)).resolves.toMatchObject({
        success: true,
      });

    expect(sandbox.mountBucket).toHaveBeenCalledTimes(1);
    expect(sandbox.exec.mock.calls.filter(([command]) => isMountProbe(command))).toHaveLength(2);
  });

  it("retries preparation after a real mount failure", async () => {
    const namespace = fakeNamespace();
    const sandbox = preparingSandbox("empty");
    const mountError = new Error("R2 mount unavailable");
    sandbox.mountBucket
      .mockRejectedValueOnce(mountError)
      .mockImplementationOnce(async () => sandbox.setMountState("mounted"));
    sandboxSdk.getSandbox.mockReturnValue(sandbox);
    const tools = cloudflareSandboxTools(namespace, "retry-session");

    await expect(tools.sandbox_exec!.handler({ command: "printf first" }, context))
      .rejects.toBe(mountError);
    await expect(tools.sandbox_exec!.handler({ command: "printf retry" }, context))
      .resolves.toMatchObject({ success: true });

    expect(sandboxSdk.getSandbox).toHaveBeenCalledTimes(2);
    expect(sandbox.mountBucket).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["occupied", "unmounted /workspace directory is not empty"],
    ["mounted-unhealthy", "existing /workspace mount is unhealthy"],
  ] as const)("refuses to remount a %s workspace", async (state, message) => {
    const sandbox = preparingSandbox(state);
    sandboxSdk.getSandbox.mockReturnValue(sandbox);

    await expect(cloudflareSandboxTools(fakeNamespace(), `${state}-session`)
      .sandbox_exec!.handler({ command: "printf unsafe" }, context)).rejects.toThrow(message);

    expect(sandbox.mountBucket).not.toHaveBeenCalled();
  });

  it("preserves the local R2 mount contract", async () => {
    const sandbox = preparingSandbox("empty");
    sandboxSdk.getSandbox.mockReturnValue(sandbox);

    await cloudflareSandboxTools(fakeNamespace(), "local-session", true)
      .sandbox_exec!.handler({ command: "printf local" }, context);

    expect(sandbox.mountBucket).toHaveBeenCalledWith(
      "NANOCODEX_WORKSPACES",
      "/workspace",
      { prefix: "/sessions/local-session/", localBucket: true },
    );
  });

  it("does not impose command or readiness timeout limits", async () => {
    const sandbox = fakeSandbox();
    const tools = createCloudflareSandboxTools(async () => sandbox);

    await tools.sandbox_exec!.handler({
      command: "cargo test",
      timeout_ms: Number.MAX_SAFE_INTEGER,
    }, context);
    await tools.sandbox_start_process!.handler({
      command: "cargo watch",
      ready_port: 3_000,
    }, context);

    expect(sandbox.exec).toHaveBeenCalledWith("cargo test", {
      cwd: "/workspace",
      timeout: Number.MAX_SAFE_INTEGER,
    });
    const process = await sandbox.startProcess.mock.results[0]!.value;
    expect(process.waitForPort).toHaveBeenCalledWith(3_000, undefined);
  });

  it("deletes every persisted object owned by a removed sandbox", async () => {
    const pages = [
      { objects: [{ key: "/sessions/session/a" }, { key: "/sessions/session/b" }] },
      { objects: [{ key: "/sessions/session/c" }] },
      { objects: [] },
    ];
    const bucket = {
      list: vi.fn(async () => pages.shift()!),
      delete: vi.fn(async () => {}),
    } as unknown as R2Bucket;

    await deleteCloudflareSandboxWorkspace(bucket, "session");

    expect(bucket.list).toHaveBeenCalledTimes(3);
    expect(bucket.list).toHaveBeenCalledWith({ prefix: "/sessions/session/", limit: 1_000 });
    expect(bucket.delete).toHaveBeenCalledWith([
      "/sessions/session/a",
      "/sessions/session/b",
    ]);
    expect(bucket.delete).toHaveBeenCalledWith(["/sessions/session/c"]);
  });
});

function fakeSandbox() {
  return {
    exec: vi.fn(async (_command: string, _options?: { cwd: string; timeout?: number }) => ({
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
      size: 0,
      content: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    })),
    writeFile: vi.fn(async () => {}),
    listFiles: vi.fn(async () => ({ files: [] })),
    tunnels: { get: vi.fn(async () => ({ url: "https://preview.example" })) },
  };
}

function preparingSandbox(initialState: MountState) {
  let mountState = initialState;
  const sandbox = {
    ...fakeSandbox(),
    mountBucket: vi.fn(async () => { mountState = "mounted"; }),
    destroy: vi.fn(async () => {}),
    setMountState(state: MountState) { mountState = state; },
  };
  sandbox.exec.mockImplementation(async (command: string) => executionResult(
    isMountProbe(command) ? mountState : "",
  ));
  return sandbox;
}

type MountState = "absent" | "empty" | "occupied" | "mounted" | "mounted-unhealthy";

function isMountProbe(command: unknown): boolean {
  return typeof command === "string" && command.startsWith("if mountpoint -q /workspace");
}

function executionResult(stdout: string) {
  return {
    success: true,
    exitCode: 0,
    stdout,
    stderr: "",
    duration: 1,
  };
}

function fakeNamespace(): DurableObjectNamespace<Sandbox> {
  return {} as DurableObjectNamespace<Sandbox>;
}
