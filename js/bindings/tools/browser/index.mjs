import "./browserBuffer.mjs";
import { prepareBrowserShell } from "./browserShell.mjs";
import * as standard from "../standard.mjs";

export {
  createBrowserBash,
  loadBrowserProjectInstructions,
} from "./browserShell.mjs";
export {
  createOpfsGitFs,
  openOpfsGitFs,
  openOpfsWorkspaceRoot,
} from "./opfsGit.mjs";
export {
  browserThread,
  commitAndPushThread,
  initializeThreadGit,
  inspectThreadGit,
  notifyThreadGitChanged,
  pullThread,
  subscribeThreadGitChanges,
  threadGitStatus,
  withThreadGitLock,
} from "./threadGit.mjs";
export {
  getBrowserThread,
  openKernelWorkspace,
  openThreadWorkspace,
  subscribeThreadWorkspaceChanges,
} from "./workspace.mjs";

export async function browser(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("browser tool options must be an object");
  }
  const origin = options.origin ?? globalThis.location?.origin;
  if (typeof options.threadId !== "string" || !options.threadId) {
    throw new TypeError("browser threadId must be a non-empty string");
  }
  if (typeof origin !== "string" || !origin) {
    throw new TypeError("browser origin is required outside a browser location");
  }
  const shell = await prepareBrowserShell(options.threadId, origin);
  return Object.freeze({
    filesystem: shell.workspace,
    instructions: shell.instructions,
    projectInstructions: shell.projectInstructions,
    tools: Object.freeze([
      standard.namedTool("exec_command", shell.execTool),
      standard.web(options.web),
      standard.imageGeneration({
        ...options.images,
        recentImages: options.recentImages,
        rememberImage: options.rememberImage,
        workspace: shell.workspace,
      }),
      standard.viewImage({ workspace: shell.workspace }),
      standard.updatePlan(),
    ]),
  });
}
