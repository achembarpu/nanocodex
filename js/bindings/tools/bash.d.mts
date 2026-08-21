import type { NamedTool } from "../types.mjs";
import type { Workspace } from "../runtime/workspace.mjs";

export type JustBashNetworkOptions = Readonly<{
  /** Explicitly permit credential-free HTTP(S) requests to arbitrary origins. */
  dangerouslyAllowFullInternetAccess?: boolean | undefined;
  /** Otherwise, allow only these exact origin/path prefixes. */
  allowedUrlPrefixes?: readonly string[] | undefined;
  /** Defaults to GET and HEAD in Just Bash. */
  allowedMethods?: readonly string[] | undefined;
}>;

export type JustBashRuntime = Readonly<{
  /**
   * The authoritative workspace handle while this runtime is mounted. All mutations must use
   * this handle so Bash's bounded metadata view remains synchronized.
   */
  filesystem: Workspace;
  /** Fixed model instructions describing the virtual shell boundary. */
  instructions: string;
  /** One-shot, cancellable `exec_command` tool backed by Just Bash. */
  tool: NamedTool;
}>;

/**
 * Mounts a caller-owned workspace into an in-isolate Just Bash runtime.
 *
 * Do not mutate the source `filesystem` handle while the runtime is mounted. Use the returned
 * `filesystem` for every mutation so the shell's metadata view remains authoritative.
 */
export function justBash(options: {
  /** Caller-owned durable workspace. See `JustBashRuntime.filesystem` for mutation ownership. */
  filesystem: Workspace;
  executionTimeoutMs?: number | undefined;
  maxEntries?: number | undefined;
  maxOutputTokens?: number | undefined;
  network?: false | JustBashNetworkOptions | undefined;
}): Promise<JustBashRuntime>;
