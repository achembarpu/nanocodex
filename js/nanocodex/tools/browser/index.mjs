import "./browserBuffer.mjs";
import {
  createBrowserEgressFetch,
  createBrowserRuntimeFetch,
  installBrowserEgressFetch,
} from "./browserEgress.mjs";
import { captureBrowserAuthority, sameBrowserAuthority } from "./browserAuthority.mjs";
import { browserAccountInfoTool, browserRuntimeInfoTool } from "./accountInfo.mjs";
import { createPreparedBrowser, usePreparedBrowser } from "./preparedBrowser.mjs";

const preparedBrowsers = new Map();

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
  selectBrowserThread,
  openKernelWorkspace,
  openThreadWorkspace,
  subscribeThreadWorkspaceChanges,
} from "./workspace.mjs";

export async function browser(options) {
  const prepared = options?.prepared ?? await prepareBrowser(options);
  return bindBrowser(prepared, options);
}

export function prepareBrowser(options) {
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
  if (options.installFetch === false) {
    const authority = captureBrowserAuthority(options);
    return prepareBrowserRuntime(options.threadId, origin, {
      ...options,
      headers: authority.headers,
    }).then((runtime) => createPreparedBrowser(runtime));
  }
  const key = `${origin}\n${options.threadId}`;
  const authority = captureBrowserAuthority(options);
  let entry = preparedBrowsers.get(key);
  if (entry && !sameBrowserAuthority(entry.authority, authority)) {
    throw new Error("browser runtime is already prepared by a different credential authority");
  }
  if (!entry) {
    entry = {
      authority,
      promise: prepareBrowserRuntime(options.threadId, origin, {
        ...options,
        headers: authority.headers,
      }).catch((error) => {
        if (preparedBrowsers.get(key) === entry) preparedBrowsers.delete(key);
        throw error;
      }),
    };
    preparedBrowsers.set(key, entry);
  }
  return entry.promise.then((runtime) => createPreparedBrowser(runtime, () => {
    if (preparedBrowsers.get(key) === entry) preparedBrowsers.delete(key);
  }));
}

async function prepareBrowserRuntime(threadId, origin, options) {
  const [shellModule, standard, datasets] = await Promise.all([
    import("./browserShell.mjs"),
    import("../standard.mjs"),
    import("../dataset.mjs"),
  ]);
  const fetch = (options.installFetch === false
    ? createBrowserRuntimeFetch
    : installBrowserEgressFetch)({
    fetch: options.fetch,
    headers: options.headers,
    origin,
    threadId,
  });
  const secureFetch = createBrowserEgressFetch({ fetch, origin, threadId });
  const shell = await shellModule.prepareBrowserShell(
    threadId,
    origin,
    secureFetch,
    options.headers,
  );
  return Object.freeze({
    origin,
    threadId,
    fetch,
    shell,
    standard,
    datasets,
  });
}

export function bindBrowser(prepared, options = {}) {
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    throw new TypeError("prepared browser runtime is required");
  }
  if (options.threadId !== undefined && options.threadId !== prepared.threadId) {
    throw new Error("prepared browser runtime belongs to a different thread");
  }
  const runtime = usePreparedBrowser(prepared);
  const { datasets, fetch, shell, standard } = runtime;
  const web = {
    url: new URL("/api/tools/web-search", runtime.origin),
    fetch,
    ...options.web,
  };
  const images = {
    url: new URL("/api/tools/image-generation", runtime.origin),
    fetch,
    ...options.images,
  };
  const account = {
    endpoint: options.accountInfo?.endpoint,
    fetch,
    origin: runtime.origin,
    requireAuthorization: options.accountInfo?.requireAuthorization,
  };
  return Object.freeze({
    filesystem: shell.workspace,
    instructions: shell.instructions,
    projectInstructions: shell.projectInstructions,
    tools: Object.freeze([
      standard.namedTool("exec_command", shell.execTool),
      browserRuntimeInfoTool(account, shell.descriptor),
      browserAccountInfoTool(account),
      standard.web(web),
      standard.imageGeneration({
        ...images,
        recentImages: options.recentImages,
        rememberImage: options.rememberImage,
        workspace: shell.workspace,
      }),
      standard.viewImage({ workspace: shell.workspace }),
      standard.updatePlan(),
      datasets.dataset(options.dataset),
      shell.artifactTool,
    ]),
  });
}

export async function createBrowserBash(rawFs, thread, options) {
  const { createBrowserBash: create } = await import("./browserShell.mjs");
  return create(rawFs, thread, options);
}

export async function loadBrowserProjectInstructions(rawFs) {
  const { loadBrowserProjectInstructions: load } = await import("./browserShell.mjs");
  return load(rawFs);
}

export async function validateBrowserArtifactSource(source) {
  const { validateBrowserArtifactSource: validate } = await import("./browserShell.mjs");
  return validate(source);
}
