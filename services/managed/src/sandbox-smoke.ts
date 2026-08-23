import type { Sandbox } from "@cloudflare/sandbox";
import type { ToolMap } from "nanocodex";

import { cloudflareSandboxTools, destroyCloudflareSandbox } from "./sandbox-tools";

export async function cloudflareSandboxSmokeSetup(
  namespace: DurableObjectNamespace<Sandbox>,
  probeId: string,
  localBucket: boolean,
  publicOrigin: string,
  previewSecret: string,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const marker = `CLOUDFLARE_SANDBOX_OK_${probeId}`;
  let tools = cloudflareSandboxTools(
    namespace,
    probeId,
    localBucket,
    publicOrigin,
    previewSecret,
  );
  try {
    // Wrangler's emulated R2 watcher takes its initial filesystem snapshot
    // asynchronously after mountBucket() returns. Let that baseline settle so
    // this write is observed as a change; production uses the direct R2 mount.
    if (localBucket) await invoke(tools, "sandbox_exec", { command: "sleep 2" });
    const write = record(await invoke(tools, "sandbox_write_file", {
      path: "probe.txt",
      content: marker,
    }));
    assert(write.bytes_written === marker.length, "write byte count mismatch");

    const exec = record(await invoke(tools, "sandbox_exec", {
      command: `test "$(cat probe.txt)" = "${marker}" && printf EXEC_OK`,
      timeout_ms: 10_000,
    }));
    assert(exec.success === true && exec.stdout === "EXEC_OK", "write was not visible to exec");

    const read = record(await invoke(tools, "sandbox_read_file", { path: "probe.txt" }));
    assert(read.content === marker, "read did not return written content");

    const list = record(await invoke(tools, "sandbox_list_files", {}));
    const entries = Array.isArray(list.entries) ? list.entries.map(record) : [];
    assert(entries.some((entry) => entry.name === "probe.txt"), "list omitted probe.txt");

    const nonzero = record(await invoke(tools, "sandbox_exec", {
      command: "sh -c 'printf partial; printf failed >&2; exit 7'",
    }));
    assert(
      nonzero.success === false
        && nonzero.exit_code === 7
        && nonzero.stdout === "partial"
        && nonzero.stderr === "failed",
      "non-zero command result was not preserved",
    );

    const flood = record(await invoke(tools, "sandbox_exec", {
      command: "node -e 'process.stdout.write(\"x\".repeat(140000)); process.stderr.write(\"y\".repeat(140000))'",
    }));
    assert(
      flood.stdout_truncated === true,
      `stdout flood was not truncated: ${JSON.stringify({
        success: flood.success,
        exit_code: flood.exit_code,
        stdout_bytes: new TextEncoder().encode(String(flood.stdout)).byteLength,
        stderr_bytes: new TextEncoder().encode(String(flood.stderr)).byteLength,
        stderr_truncated: flood.stderr_truncated,
      })}`,
    );
    assert(flood.stderr_truncated === true, "stderr flood was not truncated");
    assert(
      new TextEncoder().encode(String(flood.stdout)).byteLength === 128 * 1024,
      "stdout was not capped at 128 KiB",
    );

    const timeoutStarted = Date.now();
    const timeoutError = await rejectedMessage(invoke(tools, "sandbox_exec", {
      command: "sleep 5",
      timeout_ms: 100,
    }));
    assert(/time|interrupt|abort/i.test(timeoutError), `unexpected timeout error: ${timeoutError}`);
    assert(Date.now() - timeoutStarted < 4_000, "command timeout was not enforced promptly");

    const traversalError = await rejectedMessage(invoke(tools, "sandbox_read_file", {
      path: "../etc/passwd",
    }));
    assert(/must not contain/.test(traversalError), "path traversal was not rejected");

    const oversizedError = await rejectedMessage(invoke(tools, "sandbox_write_file", {
      path: "oversized.txt",
      content: "😀".repeat(1024 * 1024 / 4 + 1),
    }));
    assert(/exceeds 1 MiB/.test(oversizedError), "oversized UTF-8 write was not rejected");

    const process = record(await invoke(tools, "sandbox_start_process", {
      command: "node -e 'require(\"http\").createServer((q,s)=>require(\"fs\").createReadStream(\"/workspace/probe.txt\").pipe(s)).listen(8000)'",
      ready_port: 8000,
      ready_timeout_ms: 10_000,
    }));
    assert(process.ready_port === 8000, "managed process did not report port readiness");
    const preview = record(await invoke(tools, "sandbox_preview", { port: 8000 }));
    const previewUrl = new URL("probe.txt", String(preview.url));
    assert(previewUrl.protocol === "https:", `preview returned an invalid URL: ${previewUrl.href}`);

    return {
      status: "ready",
      probe_id: probeId,
      marker,
      preview_url: previewUrl.href,
      checks: [
        "write_exec_read",
        "directory_list",
        "nonzero_exit",
        "bounded_output",
        "command_timeout",
        "path_confinement",
        "write_size_limit",
        "managed_process_preview",
      ],
      duration_ms: Date.now() - started,
    };
  } catch (error) {
    await destroyCloudflareSandbox(namespace, probeId).catch(() => {});
    throw error;
  }
}

export async function cloudflareSandboxSmokeFinish(
  namespace: DurableObjectNamespace<Sandbox>,
  probeId: string,
  localBucket: boolean,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const marker = `CLOUDFLARE_SANDBOX_OK_${probeId}`;
  try {
    await destroyCloudflareSandbox(namespace, probeId);
    const tools = cloudflareSandboxTools(namespace, probeId, localBucket);
    const persisted = record(await invoke(tools, "sandbox_read_file", { path: "probe.txt" }));
    assert(persisted.content === marker, "R2 workspace did not survive container destruction");
    await invoke(tools, "sandbox_exec", { command: "rm -f probe.txt" });
    return {
      status: "ok",
      probe_id: probeId,
      checks: ["r2_restart_persistence"],
      duration_ms: Date.now() - started,
    };
  } finally {
    await destroyCloudflareSandbox(namespace, probeId).catch(() => {});
  }
}

async function invoke(tools: ToolMap, name: string, input: unknown): Promise<unknown> {
  const tool = tools[name];
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool.handler(input, {
    callId: "smoke",
    parentCallId: "smoke",
    sessionId: "smoke",
    signal: new AbortController().signal,
  });
}

async function rejectedMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("operation unexpectedly succeeded");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool returned a non-object result");
  }
  return value as Record<string, unknown>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
