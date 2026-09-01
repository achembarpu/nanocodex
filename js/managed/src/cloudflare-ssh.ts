import { connect as cloudflareConnect } from "cloudflare:sockets";
import {
  createSshCommand,
  createWebStreamSshStream,
  type SshCommandResult,
  type SshIdentityReferenceRequest,
} from "nanocodex/tools/ssh";
import type { Workspace } from "nanocodex/workspace";

type SocketLike = Readonly<{
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<void>;
  close(): Promise<void>;
}>;

type Connect = (
  address: Readonly<{ hostname: string; port: number }>,
  options: Readonly<{ allowHalfOpen: boolean; secureTransport: "off" }>,
) => SocketLike;

/** Mounts direct and private-egress SSH into Just Bash without a Linux sandbox. */
export function createCloudflareSshCommand(options: Readonly<{
  connect?: Connect;
  egress?: Fetcher;
  filesystem(): Workspace;
  resolvePassword?(reference: string): Promise<string>;
  sshIdentityAllowed?(reference: string): boolean;
  subject?: string;
}>) {
  const open = options.connect ?? cloudflareConnect as Connect;
  return createSshCommand({
    transport: "tcp",
    maxOutputBytes: 4 * 1024 * 1024,
    readIdentity: async (path, context) => new TextDecoder().decode(
      await options.filesystem().readFile(resolveWorkspacePath(
        options.filesystem().root,
        context.cwd,
        path,
      )),
    ),
    ...(options.resolvePassword === undefined
      ? {}
      : { resolvePassword: options.resolvePassword }),
    ...(options.egress === undefined || options.subject === undefined
      ? {}
      : {
          executeWithIdentityReference: (
            request: SshIdentityReferenceRequest,
            context: Readonly<{ signal?: AbortSignal }>,
          ) => {
            if (options.sshIdentityAllowed !== undefined
              && !options.sshIdentityAllowed(request.identityReference)) {
              throw new Error("SSH identity is not granted for this turn");
            }
            return executeBrokeredSsh(options.egress!, options.subject!, request, context.signal);
          },
        }),
    async openStream(endpoint, signal) {
      if (endpoint instanceof URL) throw new Error("TCP SSH requires a host and port");
      const socket = open(endpoint, { allowHalfOpen: true, secureTransport: "off" });
      try {
        await abortable(socket.opened, signal);
        return createWebStreamSshStream(socket, signal);
      } catch (error) {
        await socket.close();
        throw error;
      }
    },
  });
}

async function executeBrokeredSsh(
  binding: Fetcher,
  subject: string,
  request: SshIdentityReferenceRequest,
  signal?: AbortSignal,
): Promise<SshCommandResult> {
  if (request.endpoint instanceof URL) throw new Error("brokered SSH requires a TCP endpoint");
  const response = await binding.fetch("https://ssh.internal/v1/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nanocodex-subject": subject,
    },
    body: JSON.stringify({
      identity_ref: request.identityReference,
      hostname: request.endpoint.hostname,
      port: request.endpoint.port,
      username: request.username,
      command: request.commandArgs,
    }),
    signal,
  });
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error("private egress returned an invalid SSH response"); }
  if (!response.ok) {
    const code = stringField(body, "error");
    throw new Error(code ? `private egress rejected SSH (${code})` : "private egress rejected SSH");
  }
  const stdout = stringField(body, "stdout");
  const stderr = stringField(body, "stderr");
  const exitCode = numberField(body, "exit_code");
  if (stdout === undefined || stderr === undefined || exitCode === undefined) {
    throw new Error("private egress returned an invalid SSH result");
  }
  return { stdout, stderr, exitCode };
}

function resolveWorkspacePath(root: string, cwd: string, path: string): string {
  const absolute = path.startsWith("/");
  if (absolute && path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`SSH identity path must stay within ${root}`);
  }
  const base = absolute ? [] : relativeParts(root, cwd);
  const parts = [...base];
  const input = absolute ? path.slice(root.length) : path;
  for (const part of input.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`SSH identity path escapes ${root}`);
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? root : `${root}/${parts.join("/")}`;
}

function relativeParts(root: string, path: string): string[] {
  if (path === root) return [];
  if (!path.startsWith(`${root}/`)) throw new Error(`SSH cwd must stay within ${root}`);
  return path.slice(root.length + 1).split("/").filter(Boolean);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("SSH command cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("SSH command cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function stringField(value: unknown, field: string): string | undefined {
  return isRecord(value) && typeof value[field] === "string" ? value[field] : undefined;
}

function numberField(value: unknown, field: string): number | undefined {
  return isRecord(value) && Number.isSafeInteger(value[field]) ? value[field] as number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
