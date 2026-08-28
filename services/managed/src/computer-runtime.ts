import type { NamedTool } from "nanocodex";
import { justBash } from "nanocodex/tools/bash";
import type { JustBashDescriptor } from "nanocodex/tools/bash";
import type { Workspace } from "nanocodex/workspace";

import {
  createManagedGitCommand,
  createManagedGhCommand,
  createManagedShellFetch,
  type ManagedShellFetch,
} from "./computer-shell";
import {
  createComputerFilesystem,
  type ComputerWorkspaceClient,
} from "./computer-workspace";
import type { ManagedEgressConnectorId } from "./managed-egress";

const MANAGED_SHELL_MAX_ENTRIES = 20_000;
const MANAGED_SHELL_MAX_OUTPUT_TOKENS = 10_000;

type DisposableComputerWorkspace = ComputerWorkspaceClient & Readonly<{
  [Symbol.dispose](): void;
}>;

export type ManagedComputerRuntime = Readonly<{
  commandNames: readonly string[];
  descriptor: JustBashDescriptor;
  dispose(): void;
  fetch: ManagedShellFetch;
  filesystem: Workspace;
  instructions: string;
  tool: NamedTool;
}>;

/**
 * Constructs the one managed Computer/Just Bash runtime used by every managed
 * agent profile. The caller controls only the egress authority: all profiles
 * receive the same mounted filesystem, shell limits, and git/gh commands.
 */
export async function createManagedComputerRuntime(options: Readonly<{
  computer: DisposableComputerWorkspace;
  connectorAllowed?: (connector: ManagedEgressConnectorId) => boolean;
  egress: Fetcher;
  subject?: string;
}>): Promise<ManagedComputerRuntime> {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.computer[Symbol.dispose]();
  };

  try {
    const sourceFilesystem = await createComputerFilesystem(options.computer);
    const fetch = createManagedShellFetch(
      options.egress,
      options.subject,
      options.connectorAllowed,
    );
    let mountedFilesystem: Workspace | undefined;
    const gitCommand = createManagedGitCommand(fetch, () => {
      if (!mountedFilesystem) throw new Error("managed shell filesystem is not mounted");
      return mountedFilesystem;
    });
    const commands = Object.freeze([
      gitCommand,
      createManagedGhCommand(fetch, (args, context) =>
        gitCommand.execute(["clone", ...args], context)),
    ]);
    const shell = await justBash({
      filesystem: sourceFilesystem,
      maxEntries: MANAGED_SHELL_MAX_ENTRIES,
      maxOutputTokens: MANAGED_SHELL_MAX_OUTPUT_TOKENS,
      fetch,
      networkMode: options.subject === undefined
        ? "public-http-only"
        : "connector-http-gateway",
      customCommands: commands,
    });
    mountedFilesystem = shell.filesystem;

    return Object.freeze({
      commandNames: shell.descriptor.customCommands,
      descriptor: shell.descriptor,
      dispose,
      fetch,
      filesystem: shell.filesystem,
      instructions: shell.instructions,
      tool: Object.freeze({ ...shell.tool, dispose }),
    });
  } catch (error) {
    dispose();
    throw error;
  }
}
