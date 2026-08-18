import type { Workspace } from "nanocodex/browser/workspace";

export const KERNEL_WORKSPACE_NAME = "nanocodex-home";

let workspace: Promise<Workspace> | undefined;

export function openKernelWorkspace(): Promise<Workspace> {
  workspace ??= import("nanocodex/browser/workspace")
    .then((module) => module.open({ name: KERNEL_WORKSPACE_NAME }))
    .catch((error) => {
      workspace = undefined;
      throw error;
    });
  return workspace;
}
