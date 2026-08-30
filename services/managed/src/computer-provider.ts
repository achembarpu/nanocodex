import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { Workspace } from "nanocodex/workspace";

const ROOT = "/workspace";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ENTRIES = 20_000;

export type ComputerCapability = "native-process";

export type ComputerRequirements = Readonly<{
  capabilities: readonly ComputerCapability[];
}>;

export type ComputerExecRequest = Readonly<{
  command: string;
  cwd: string;
  requirements: ComputerRequirements;
  timeoutMs?: number;
}>;

export type ComputerExecResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type ManagedComputerProvider = Readonly<{
  exec(request: ComputerExecRequest): Promise<ComputerExecResult>;
}>;

type SandboxClient = Readonly<{
  exec(command: string, options: { cwd: string; timeout: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, content: string, options: { encoding: "utf-8" }): Promise<unknown>;
}>;

/**
 * Full-Linux provider backed by Cloudflare Sandbox. The Sandbox is acquired
 * lazily on the first native-process request; ordinary Just Bash work never
 * starts a container. The durable Computer workspace remains canonical and is
 * materialized into the Sandbox immediately before native execution.
 */
export function createCloudflareSandboxComputerProvider(options: Readonly<{
  namespace: DurableObjectNamespace<Sandbox>;
  sessionId: string;
  workspace: Workspace;
  localBucket?: boolean;
}>): ManagedComputerProvider {
  let sandboxPromise: Promise<SandboxClient> | undefined;
  const sandbox = () => sandboxPromise ??= prepareSandbox(
    options.namespace,
    options.sessionId,
    options.localBucket === true,
  );

  return Object.freeze({
    async exec(request) {
      requireCapabilities(request.requirements, ["native-process"]);
      const client = await sandbox();
      await materializeWorkspace(options.workspace, client);
      const result = await client.exec(request.command, {
        cwd: sandboxPath(request.cwd),
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  });
}

/** Testable provider core used by the Cloudflare adapter. */
export function createSandboxComputerProvider(options: Readonly<{
  sandbox: () => Promise<SandboxClient>;
  workspace: Workspace;
}>): ManagedComputerProvider {
  let sandboxPromise: Promise<SandboxClient> | undefined;
  const sandbox = () => sandboxPromise ??= options.sandbox();
  return Object.freeze({
    async exec(request) {
      requireCapabilities(request.requirements, ["native-process"]);
      const client = await sandbox();
      await materializeWorkspace(options.workspace, client);
      const result = await client.exec(request.command, {
        cwd: sandboxPath(request.cwd),
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  });
}

async function prepareSandbox(
  namespace: DurableObjectNamespace<Sandbox>,
  sessionId: string,
  localBucket: boolean,
): Promise<Sandbox> {
  const sandbox = getSandbox(namespace, `nanocodex-compute-${sessionId}`, {
    normalizeId: true,
    sleepAfter: "10m",
    transport: "rpc",
    labels: { application: "nanocodex", session: sessionId, purpose: "compute" },
  });
  try {
    await sandbox.mountBucket("NANOCODEX_WORKSPACES", ROOT, {
      prefix: `/compute/${sessionId}/`,
      ...(localBucket ? { localBucket: true as const } : {}),
    });
  } catch (error) {
    if (!message(error).toLowerCase().includes("mount path already in use")) throw error;
  }
  return sandbox;
}

async function materializeWorkspace(workspace: Workspace, sandbox: SandboxClient): Promise<void> {
  const entries = await workspace.list(".", { recursive: true, maxEntries: MAX_ENTRIES });
  const directories = entries
    .filter((entry) => entry.kind === "directory")
    .map((entry) => sandboxPath(entry.path));
  if (directories.length > 0) {
    await sandbox.exec(`mkdir -p ${directories.map(shellQuote).join(" ")}`, {
      cwd: ROOT,
      timeout: DEFAULT_TIMEOUT_MS,
    });
  }
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const path = sandboxPath(entry.path);
    const parent = path.slice(0, path.lastIndexOf("/")) || ROOT;
    await sandbox.exec(`mkdir -p ${shellQuote(parent)}`, { cwd: ROOT, timeout: DEFAULT_TIMEOUT_MS });
    const bytes = await workspace.readFile(entry.path);
    await sandbox.writeFile(path, new TextDecoder().decode(bytes), { encoding: "utf-8" });
  }
}

function requireCapabilities(
  requested: ComputerRequirements,
  supported: readonly ComputerCapability[],
): void {
  const available = new Set(supported);
  for (const capability of requested.capabilities) {
    if (!available.has(capability)) throw new Error(`computer capability unavailable: ${capability}`);
  }
}

function sandboxPath(raw: string): string {
  if (raw === ROOT) return ROOT;
  let relative = raw;
  if (relative.startsWith(`${ROOT}/`)) relative = relative.slice(ROOT.length + 1);
  else if (relative.startsWith("/")) throw new Error(`computer cwd must stay within ${ROOT}`);
  const parts = relative.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new Error(`computer cwd must stay within ${ROOT}`);
  return parts.length === 0 ? ROOT : `${ROOT}/${parts.join("/")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
