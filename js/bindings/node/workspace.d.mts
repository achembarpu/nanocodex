import type { Workspace, WorkspaceBackend } from "../runtime/workspace.mjs";

export { tools } from "../runtime/workspace.mjs";

export function open(options: {
  path: string;
}): Promise<Workspace>;

export type { Workspace, WorkspaceBackend };
