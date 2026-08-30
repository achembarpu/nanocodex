import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { Workspace } from "nanocodex/workspace";

const ROOT = "/workspace";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ENTRIES = 20_000;
const EXE_WRITE_CHUNK_BYTES = 24 * 1024;

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
  dispose?(): Promise<void> | void;
  exec(request: ComputerExecRequest): Promise<ComputerExecResult>;
}>;

type ComputerMachine = Readonly<{
  close?(): Promise<void> | void;
  exec(command: string, options: { cwd: string; timeout: number }): Promise<ComputerExecResult>;
  writeFile(path: string, contents: Uint8Array): Promise<void>;
}>;

type CloudflareSandboxClient = Readonly<{
  exec(command: string, options: { cwd: string; timeout: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, content: string, options: { encoding: "utf-8" }): Promise<unknown>;
}>;

type VercelSandboxClient = Readonly<{
  runCommand(input: { cmd: string; args: string[]; cwd?: string }): Promise<{
    exitCode: number;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  }>;
  stop(): Promise<unknown>;
  writeFiles(files: Array<{ path: string; content: Uint8Array }>): Promise<unknown>;
}>;

type IxMachineClient = Readonly<{
  delete(): Promise<unknown>;
  exec(argv: string[]): Promise<{
    stdout: string;
    stderr: string;
    exitCode?: number;
    exit_code?: number;
    code?: number;
  }>;
  writeFile(path: string, contents: Uint8Array): Promise<unknown>;
}>;

/**
 * Full-Linux provider backed by Cloudflare Sandbox. The Sandbox is acquired
 * lazily on the first native-process request; ordinary Just Bash work never
 * starts a container. We intentionally own workspace materialization instead
 * of depending on Cloudflare Computer's execution backend.
 */
export function createCloudflareSandboxComputerProvider(options: Readonly<{
  namespace: DurableObjectNamespace<Sandbox>;
  sessionId: string;
  workspace: Workspace;
}>): ManagedComputerProvider {
  return createMachineComputerProvider({
    workspace: options.workspace,
    createMachine: async () => cloudflareMachine(getSandbox(
      options.namespace,
      `nanocodex-compute-${options.sessionId}`,
      {
        normalizeId: true,
        sleepAfter: "10m",
        transport: "rpc",
        labels: { application: "nanocodex", session: options.sessionId, purpose: "compute" },
      },
    )),
  });
}

/**
 * Adapter for `@vercel/sandbox`. The caller owns authentication and imports the
 * SDK; Nanocodex owns when the sandbox is requested and how the workspace is
 * materialized. A normal factory is `() => Sandbox.create({ persistent: false })`.
 */
export function createVercelSandboxComputerProvider(options: Readonly<{
  createSandbox: () => Promise<VercelSandboxClient>;
  workspace: Workspace;
}>): ManagedComputerProvider {
  return createMachineComputerProvider({
    workspace: options.workspace,
    createMachine: async () => {
      const sandbox = await options.createSandbox();
      return {
        async exec(command, request) {
          const result = await sandbox.runCommand({
            cmd: "bash",
            args: ["-lc", command],
            cwd: request.cwd,
          });
          return {
            stdout: await result.stdout(),
            stderr: await result.stderr(),
            exitCode: result.exitCode,
          };
        },
        async writeFile(path, contents) {
          await sandbox.writeFiles([{ path, content: contents }]);
        },
        async close() { await sandbox.stop(); },
      };
    },
  });
}

/**
 * Adapter for `@indexable/sdk`. The caller supplies `ix.machines().create(...)`
 * so credentials, region, and ix templates stay outside the generic runtime.
 */
export function createIxComputerProvider(options: Readonly<{
  createMachine: () => Promise<IxMachineClient>;
  workspace: Workspace;
}>): ManagedComputerProvider {
  return createMachineComputerProvider({
    workspace: options.workspace,
    createMachine: async () => {
      const machine = await options.createMachine();
      return {
        async exec(command, request) {
          const result = await machine.exec([
            "bash",
            "-lc",
            `cd ${shellQuote(request.cwd)} && exec ${command}`,
          ]);
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: numericExitCode(result),
          };
        },
        async writeFile(path, contents) { await machine.writeFile(path, contents); },
        async close() { await machine.delete(); },
      };
    },
  });
}

/**
 * exe.dev adapter using its HTTPS form of the SSH API. The token must allow
 * `new`, `ssh`, and `rm`. The VM is created lazily and deleted when the provider
 * is disposed. No Nanocodex process is installed in the VM.
 */
export function createExeComputerProvider(options: Readonly<{
  fetch?: typeof fetch;
  image?: string;
  name: string;
  token: string;
  workspace: Workspace;
}>): ManagedComputerProvider {
  requireExeName(options.name);
  if (!options.token) throw new Error("exe.dev token is required");
  const request = options.fetch ?? fetch;
  const image = options.image ?? "exeuntu";
  return createMachineComputerProvider({
    workspace: options.workspace,
    createMachine: async () => {
      await exeApi(request, options.token, `new --name=${options.name} --image=${image}`);
      return {
        async exec(command, input) {
          return exeRemoteExec(
            request,
            options.token,
            options.name,
            `cd ${shellQuote(input.cwd)} && exec ${command}`,
          );
        },
        async writeFile(path, contents) {
          const parent = path.slice(0, path.lastIndexOf("/")) || ROOT;
          await exeRemoteExec(
            request,
            options.token,
            options.name,
            `mkdir -p ${shellQuote(parent)} && : > ${shellQuote(path)}`,
          );
          for (let offset = 0; offset < contents.byteLength; offset += EXE_WRITE_CHUNK_BYTES) {
            const chunk = contents.subarray(offset, offset + EXE_WRITE_CHUNK_BYTES);
            const encoded = base64(chunk);
            await exeRemoteExec(
              request,
              options.token,
              options.name,
              `printf %s ${shellQuote(encoded)} | base64 -d >> ${shellQuote(path)}`,
            );
          }
        },
        async close() {
          await exeApi(request, options.token, `rm ${options.name}`);
        },
      };
    },
  });
}

/** Testable provider core shared by every remote computer adapter. */
export function createMachineComputerProvider(options: Readonly<{
  createMachine: () => Promise<ComputerMachine>;
  workspace: Workspace;
}>): ManagedComputerProvider {
  let machinePromise: Promise<ComputerMachine> | undefined;
  let closed = false;
  const machine = () => {
    if (closed) throw new Error("computer provider is disposed");
    return machinePromise ??= options.createMachine();
  };
  return Object.freeze({
    async exec(request) {
      requireCapabilities(request.requirements, ["native-process"]);
      const client = await machine();
      await materializeWorkspace(options.workspace, client);
      return client.exec(request.command, {
        cwd: sandboxPath(request.cwd),
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
    async dispose() {
      if (closed) return;
      closed = true;
      if (machinePromise === undefined) return;
      const client = await machinePromise;
      await client.close?.();
    },
  });
}

/** Compatibility helper retained for focused tests and custom providers. */
export function createSandboxComputerProvider(options: Readonly<{
  sandbox: () => Promise<CloudflareSandboxClient>;
  workspace: Workspace;
}>): ManagedComputerProvider {
  return createMachineComputerProvider({
    workspace: options.workspace,
    createMachine: async () => cloudflareMachine(await options.sandbox()),
  });
}

function cloudflareMachine(sandbox: CloudflareSandboxClient): ComputerMachine {
  return {
    async exec(command, options) {
      const result = await sandbox.exec(command, options);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    async writeFile(path, contents) {
      await sandbox.writeFile(path, new TextDecoder().decode(contents), { encoding: "utf-8" });
    },
  };
}

async function materializeWorkspace(workspace: Workspace, machine: ComputerMachine): Promise<void> {
  const entries = await workspace.list(".", { recursive: true, maxEntries: MAX_ENTRIES });
  const directories = entries
    .filter((entry) => entry.kind === "directory")
    .map((entry) => sandboxPath(entry.path));
  if (directories.length > 0) {
    const mkdir = await machine.exec(`mkdir -p ${directories.map(shellQuote).join(" ")}`, {
      cwd: ROOT,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    requireSuccessfulSetup(mkdir, "workspace directory materialization");
  }
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const path = sandboxPath(entry.path);
    const parent = path.slice(0, path.lastIndexOf("/")) || ROOT;
    const mkdir = await machine.exec(`mkdir -p ${shellQuote(parent)}`, {
      cwd: ROOT,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    requireSuccessfulSetup(mkdir, `workspace parent materialization for ${entry.path}`);
    await machine.writeFile(path, await workspace.readFile(entry.path));
  }
}

function requireSuccessfulSetup(result: ComputerExecResult, operation: string): void {
  if (result.exitCode === 0) return;
  throw new Error(`${operation} failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`);
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

function numericExitCode(result: { exitCode?: number; exit_code?: number; code?: number }): number {
  const value = result.exitCode ?? result.exit_code ?? result.code;
  if (!Number.isInteger(value)) throw new Error("compute provider returned no numeric exit code");
  return value!;
}

async function exeApi(
  request: typeof fetch,
  token: string,
  command: string,
): Promise<unknown> {
  const response = await request("https://exe.dev/exec", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    body: command,
    redirect: "error",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`exe.dev ${command.split(" ", 1)[0]} failed: HTTP ${response.status}: ${body}`);
  if (!body.trim()) return {};
  try { return JSON.parse(body); } catch { return { stdout: body }; }
}

async function exeRemoteExec(
  request: typeof fetch,
  token: string,
  name: string,
  command: string,
): Promise<ComputerExecResult> {
  const raw = await exeApi(request, token, `ssh ${name} bash -lc ${shellQuote(command)}`);
  return exeResult(raw);
}

function exeResult(value: unknown): ComputerExecResult {
  const record = object(value);
  const nested = record.result && typeof record.result === "object" && !Array.isArray(record.result)
    ? object(record.result)
    : record;
  const stdout = text(nested.stdout) ?? text(nested.output) ?? "";
  const stderr = text(nested.stderr) ?? text(nested.error) ?? "";
  const exitCode = integer(nested.exitCode)
    ?? integer(nested.exit_code)
    ?? integer(nested.code)
    ?? (nested.success === false ? 1 : 0);
  return { stdout, stderr, exitCode };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isInteger(value) ? value as number : undefined;
}

function base64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function requireExeName(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value)) throw new Error("invalid exe.dev machine name");
}
