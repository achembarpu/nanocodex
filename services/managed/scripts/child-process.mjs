import { spawn } from "node:child_process";

export function spawnProcessGroup(command, arguments_ = [], options = {}) {
  const child = spawn(command, arguments_, {
    ...options,
    detached: process.platform !== "win32",
  });
  let settled = false;
  let residualProcessGroup = false;
  const exit = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      settled = true;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      settled = true;
      residualProcessGroup = process.platform !== "win32"
        && child.pid !== undefined
        && processGroupExists(child.pid);
      resolve({ code, signal });
    });
  });
  let termination;
  return {
    child,
    exit,
    terminate(graceMs = 2_000) {
      if (termination) return termination;
      termination = (async () => {
        if (settled && !residualProcessGroup) return;
        signalProcessGroup(child, "SIGTERM");
        if (process.platform !== "win32" && child.pid !== undefined) {
          if (await processGroupGoneWithin(child.pid, graceMs)) {
            residualProcessGroup = false;
            return;
          }
        } else if (await settlesWithin(exit, graceMs)) {
          return;
        }
        signalProcessGroup(child, "SIGKILL");
        await exit.catch(() => {});
        if (process.platform !== "win32" && child.pid !== undefined) {
          residualProcessGroup = !await processGroupGoneWithin(child.pid, 1_000);
          if (residualProcessGroup) {
            throw new Error(`process group ${child.pid} survived SIGKILL`);
          }
        }
      })();
      return termination;
    },
  };
}

export async function runBoundedProcess(command, arguments_, {
  cwd,
  env = process.env,
  label = command,
  maxOutputBytes = 64 * 1024,
  onSpawn,
  redact = String,
  signal,
  terminationGraceMs = 2_000,
  timeoutMs,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("child process timeout must be a positive integer");
  }
  signal?.throwIfAborted();
  const handle = spawnProcessGroup(command, arguments_, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  onSpawn?.(handle);
  const output = boundedOutput(handle.child, maxOutputBytes);
  let timeout;
  let onAbort;
  const interruption = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    if (signal) {
      onAbort = () => reject(signal.reason ?? new Error(`${label} was aborted`));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    const { code, signal: exitSignal } = await Promise.race([handle.exit, interruption]);
    await handle.terminate(terminationGraceMs);
    const detail = output.value();
    if (code === 0) return detail;
    throw new Error(`${label} exited with ${code ?? exitSignal}: ${redact(detail)}`);
  } catch (error) {
    await handle.terminate(terminationGraceMs);
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function isMissingWorkerDeleteError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\[(?:code: )?10090\]/i.test(message)
    || /\bscript[_ -]?not[_ -]?found\b/i.test(message)
    || /\bworker script\b[^\n]{0,120}\b(?:was )?not found\b/i.test(message)
    || /\b(?:worker|script)(?: named| called)?\b[^\n]{0,120}\bdoes not exist\b/i.test(message)
    || /\b(?:no such worker|worker(?: script)? not found)\b/i.test(message);
}

function boundedOutput(child, limit) {
  const chunks = [];
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      chunks.push(chunk);
      bytes += Buffer.byteLength(chunk);
      while (bytes > limit && chunks.length > 1) {
        bytes -= Buffer.byteLength(chunks.shift());
      }
      if (bytes > limit && chunks.length === 1) {
        chunks[0] = chunks[0].slice(-limit);
        bytes = Buffer.byteLength(chunks[0]);
      }
    });
  }
  return { value: () => chunks.join("") };
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function processGroupGoneWithin(processGroupId, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    if (!processGroupExists(processGroupId)) return true;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
  }
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}
