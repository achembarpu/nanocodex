import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

import { openOpfsGitFs } from "./opfsGit.ts";
import type { BrowserThread } from "./workspace.ts";

export const THREAD_GIT_DIRECTORY = "/workspace";
export const THREAD_GIT_AUTHOR = { name: "Nanocodex", email: "agent@nanocodex.dev" };
const directory = THREAD_GIT_DIRECTORY;
const author = THREAD_GIT_AUTHOR;
const localLocks = new Map<string, Promise<unknown>>();

export type ThreadGitStatus = {
  branch: "nanocodex";
  head?: string;
  changes: string[];
  remoteUrl: string;
};

export function browserThread(threadId: string, origin: string): BrowserThread {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(threadId)) {
    throw new Error("invalid browser thread id");
  }
  return {
    id: threadId,
    workspaceName: `nanocodex-thread-${threadId}`,
    repositoryName: `thread-${threadId}`,
    branch: "nanocodex",
    remoteUrl: `${origin}/git/thread-${threadId}`,
    shareUrl: origin,
  };
}

export async function initializeThreadGit(thread: BrowserThread): Promise<ThreadGitStatus> {
  return inspectThreadGit(thread, async (fs) => {
    return status(fs, thread);
  });
}

export async function inspectThreadGit<T>(
  thread: BrowserThread,
  inspect: (fs: Awaited<ReturnType<typeof openOpfsGitFs>>) => Promise<T>,
): Promise<T> {
  return withThreadGitLock(thread, async () => {
    const fs = await openOpfsGitFs(thread.workspaceName);
    if (!(await exists(fs, `${directory}/.git/config`))) {
      await initializeOrRestore(fs, thread);
    }
    await configureRemote(fs, thread);
    return inspect(fs);
  });
}

export async function threadGitStatus(thread: BrowserThread): Promise<ThreadGitStatus> {
  return withThreadGitLock(thread, async () => {
    const fs = await openOpfsGitFs(thread.workspaceName);
    if (!(await exists(fs, `${directory}/.git/config`))) await initializeOrRestore(fs, thread);
    return status(fs, thread);
  });
}

export async function commitAndPushThread(
  thread: BrowserThread,
  message = "Update workspace",
): Promise<ThreadGitStatus> {
  return withThreadGitLock(thread, async () => {
    const fs = await openOpfsGitFs(thread.workspaceName);
    if (!(await exists(fs, `${directory}/.git/config`))) await initializeOrRestore(fs, thread);
    await configureRemote(fs, thread);
    const matrix = await git.statusMatrix({ fs, dir: directory });
    const changed = matrix.filter(([, headStatus, workdirStatus]) => headStatus !== workdirStatus);
    for (const [filepath, , workdirStatus] of changed) {
      if (workdirStatus === 0) await git.remove({ fs, dir: directory, filepath });
      else await git.add({ fs, dir: directory, filepath });
    }
    if (changed.length > 0) {
      await git.commit({ fs, dir: directory, message: message.trim() || "Update workspace", author });
    }
    const head = await resolveHead(fs);
    if (!head) throw new Error("Create at least one workspace file before the first push");
    await git.push({
      fs,
      http,
      dir: directory,
      remote: "origin",
      ref: thread.branch,
      remoteRef: thread.branch,
    });
    const next = await status(fs, thread);
    notifyThreadGitChanged(thread);
    return next;
  });
}

export async function pullThread(thread: BrowserThread): Promise<ThreadGitStatus> {
  return withThreadGitLock(thread, async () => {
    const fs = await openOpfsGitFs(thread.workspaceName);
    if (!(await exists(fs, `${directory}/.git/config`))) await initializeOrRestore(fs, thread);
    await configureRemote(fs, thread);
    const refs = await remoteRefs(thread);
    if (!refs.some((ref) => ref.ref === thread.branch || ref.ref === `refs/heads/${thread.branch}`)) {
      throw new Error("This thread has not been pushed yet");
    }
    if (await resolveHead(fs)) {
      await git.pull({ fs, http, dir: directory, remote: "origin", ref: thread.branch, author });
    } else {
      await restoreRemote(fs, thread);
    }
    const next = await status(fs, thread);
    notifyThreadGitChanged(thread);
    return next;
  });
}

export function subscribeThreadGitChanges(
  thread: BrowserThread,
  listener: () => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(`nanocodex-git-${thread.id}`);
  channel.addEventListener("message", listener);
  return () => channel.close();
}

export function notifyThreadGitChanged(thread: BrowserThread): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(`nanocodex-git-${thread.id}`);
  channel.postMessage({ type: "changed" });
  channel.close();
}

async function initializeOrRestore(fs: Awaited<ReturnType<typeof openOpfsGitFs>>, thread: BrowserThread) {
  const refs = await remoteRefs(thread);
  await git.init({ fs, dir: directory, defaultBranch: thread.branch });
  await configureRemote(fs, thread);
  if (refs.some((ref) => ref.ref === thread.branch || ref.ref === `refs/heads/${thread.branch}`)) {
    await restoreRemote(fs, thread);
  }
}

async function restoreRemote(fs: Awaited<ReturnType<typeof openOpfsGitFs>>, thread: BrowserThread) {
  const fetched = await git.fetch({
    fs,
    http,
    dir: directory,
    remote: "origin",
    ref: thread.branch,
    singleBranch: true,
  });
  const oid = fetched.fetchHead;
  if (!oid) throw new Error("The thread remote did not return a branch head");
  await git.writeRef({ fs, dir: directory, ref: `refs/heads/${thread.branch}`, value: oid, force: true });
  await git.checkout({ fs, dir: directory, ref: thread.branch, force: true });
}

async function configureRemote(fs: Awaited<ReturnType<typeof openOpfsGitFs>>, thread: BrowserThread) {
  await git.addRemote({ fs, dir: directory, remote: "origin", url: thread.remoteUrl, force: true });
  await git.setConfig({ fs, dir: directory, path: `branch.${thread.branch}.remote`, value: "origin" });
  await git.setConfig({
    fs,
    dir: directory,
    path: `branch.${thread.branch}.merge`,
    value: `refs/heads/${thread.branch}`,
  });
  await git.setConfig({ fs, dir: directory, path: "user.name", value: author.name });
  await git.setConfig({ fs, dir: directory, path: "user.email", value: author.email });
}

async function status(
  fs: Awaited<ReturnType<typeof openOpfsGitFs>>,
  thread: BrowserThread,
): Promise<ThreadGitStatus> {
  const matrix = await git.statusMatrix({ fs, dir: directory });
  return {
    branch: thread.branch,
    head: await resolveHead(fs),
    changes: matrix
      .filter(([, headStatus, workdirStatus, stageStatus]) =>
        headStatus !== workdirStatus || headStatus !== stageStatus)
      .map(([filepath]) => filepath),
    remoteUrl: thread.remoteUrl,
  };
}

async function remoteRefs(thread: BrowserThread) {
  return git.listServerRefs({ http, url: thread.remoteUrl, protocolVersion: 2, prefix: "refs/heads/" });
}

async function resolveHead(fs: Awaited<ReturnType<typeof openOpfsGitFs>>): Promise<string | undefined> {
  return git.resolveRef({ fs, dir: directory, ref: "HEAD" }).catch(() => undefined);
}

async function exists(fs: Awaited<ReturnType<typeof openOpfsGitFs>>, path: string): Promise<boolean> {
  return fs.promises.stat(path).then(() => true, () => false);
}

export async function withThreadGitLock<T>(
  thread: BrowserThread,
  operation: () => Promise<T>,
): Promise<T> {
  if (navigator.locks) {
    return navigator.locks.request(`nanocodex-git-${thread.id}`, operation);
  }
  const previous = localLocks.get(thread.id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  localLocks.set(thread.id, current);
  try {
    return await current;
  } finally {
    if (localLocks.get(thread.id) === current) localLocks.delete(thread.id);
  }
}
