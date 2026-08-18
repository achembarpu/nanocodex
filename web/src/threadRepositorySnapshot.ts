import { createTwoFilesPatch, diffLines } from "diff";
import git, { type ReadCommitResult, type WalkerEntry } from "isomorphic-git";

import type { OpfsGitFs } from "./opfsGit.ts";

const directory = "/workspace";
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type RepositoryFile = {
  path: string;
  mode: string;
  objectId: string;
  size: number | null;
  contentUrl: string | null;
};

export type SerializedTreeInput = {
  paths: string[];
  preparedPaths: Array<{
    basename: string;
    isDirectory: boolean;
    path: string;
    segments: string[];
  }>;
};

export type ChangedFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
};

export type HarnessCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authoredAt: string;
  refs: string[];
  subject: string;
  body: string;
  files: ChangedFile[];
  stats: {
    files: number;
    additions: number;
    deletions: number;
  };
};

export type RepositorySnapshot = {
  repository: {
    fullName: string;
    branch: string;
    head: string;
    totalCommits: number;
    dirty: boolean;
    dirtyCount: number;
  };
  generatedAt: string;
  commitPatchUrl: string;
  tree: RepositoryFile[];
  treeInput: SerializedTreeInput;
  commits: HarnessCommit[];
  release(): void;
};

export async function loadThreadRepositorySnapshot(): Promise<RepositorySnapshot> {
  const [{ inspectThreadGit }, { getBrowserThread }] = await Promise.all([
    import("./threadGit.ts"),
    import("./workspace.ts"),
  ]);
  const thread = getBrowserThread();
  return inspectThreadGit(thread, (fs) => buildThreadRepositorySnapshot(
    fs,
    thread.repositoryName,
    thread.branch,
  ));
}

export async function buildThreadRepositorySnapshot(
  fs: OpfsGitFs,
  repositoryName: string,
  branch: "nanocodex",
): Promise<RepositorySnapshot> {
  const head = await git.resolveRef({ fs, dir: directory, ref: "HEAD" })
    .catch(() => undefined);
  const blobCache = new Map<string, Uint8Array>();
  const resourceUrls: string[] = [];
  const tree = head
    ? await readHeadFiles(fs, head, blobCache, resourceUrls)
    : await readWorktreeFiles(fs, resourceUrls);
  const log = head
    ? await git.log({ fs, dir: directory, ref: head, includeChanges: true })
    : [];
  const { commits, patch } = await readCommits(fs, log, head, blobCache);
  const commitPatchUrl = resourceUrl(new Blob([patch], { type: "text/x-diff" }), resourceUrls);
  const dirtyCount = (await git.statusMatrix({ fs, dir: directory }))
    .filter(([, headStatus, workdirStatus, stageStatus]) =>
      headStatus !== workdirStatus || headStatus !== stageStatus).length;
  const paths = tree.map(({ path }) => path);

  return {
    repository: {
      fullName: repositoryName,
      branch,
      head: head ?? "unborn",
      totalCommits: commits.length,
      dirty: dirtyCount > 0,
      dirtyCount,
    },
    generatedAt: new Date().toISOString(),
    commitPatchUrl,
    tree,
    treeInput: {
      paths,
      preparedPaths: paths.map((path) => {
        const segments = path.split("/");
        return {
          basename: segments.at(-1) ?? path,
          isDirectory: false,
          path,
          segments,
        };
      }),
    },
    commits,
    release() {
      for (const url of resourceUrls) URL.revokeObjectURL(url);
      resourceUrls.length = 0;
    },
  };
}

async function readWorktreeFiles(
  fs: OpfsGitFs,
  resourceUrls: string[],
): Promise<RepositoryFile[]> {
  const files: RepositoryFile[] = [];
  const visit = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = relativeDirectory
      ? `${directory}/${relativeDirectory}`
      : directory;
    const names = await fs.promises.readdir(absoluteDirectory);
    for (const name of names.sort()) {
      if (!relativeDirectory && name === ".git") continue;
      const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolutePath = `${directory}/${path}`;
      const stat = await fs.promises.stat(absolutePath);
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      const contents = await fs.promises.readFile(absolutePath);
      if (typeof contents === "string") throw new Error(`Unexpected text read for ${path}`);
      const bytes = contents.slice();
      files.push({
        path,
        mode: "100644",
        objectId: (await git.hashBlob({ object: bytes })).oid,
        size: bytes.byteLength,
        contentUrl: resourceUrl(new Blob([bytes.buffer]), resourceUrls),
      });
    }
  };
  await visit("");
  return files;
}

async function readHeadFiles(
  fs: OpfsGitFs,
  head: string,
  blobCache: Map<string, Uint8Array>,
  resourceUrls: string[],
): Promise<RepositoryFile[]> {
  const files = await git.walk({
    fs,
    dir: directory,
    trees: [git.TREE({ ref: head })],
    map: async (path: string, entries: Array<WalkerEntry | null>) => {
      const entry = entries[0];
      if (path === "." || !entry || await entry.type() !== "blob") return [];
      const bytes = await entry.content();
      if (!bytes) return [];
      const oid = await entry.oid();
      const contents = bytes.slice();
      blobCache.set(oid, contents);
      return [{
        path,
        mode: (await entry.mode()).toString(8).padStart(6, "0"),
        objectId: oid,
        size: contents.byteLength,
        contentUrl: resourceUrl(new Blob([contents.buffer]), resourceUrls),
      } satisfies RepositoryFile];
    },
    reduce: async (parent: RepositoryFile[], children: RepositoryFile[][]) => [
      ...parent,
      ...children.flat(),
    ],
  }) as RepositoryFile[];
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readCommits(
  fs: OpfsGitFs,
  log: ReadCommitResult[],
  head: string | undefined,
  blobCache: Map<string, Uint8Array>,
): Promise<{ commits: HarnessCommit[]; patch: string }> {
  const commits: HarnessCommit[] = [];
  const patches: string[] = [];
  for (const entry of log) {
    const files: ChangedFile[] = [];
    const filePatches: string[] = [];
    for (const change of entry.commit.changes ?? []) {
      const [newOid, oldOid, path] = change;
      if (typeof path !== "string") continue;
      const oldBytes = typeof oldOid === "string" ? await readBlob(fs, oldOid, blobCache) : undefined;
      const newBytes = typeof newOid === "string" ? await readBlob(fs, newOid, blobCache) : undefined;
      const oldText = decodeText(oldBytes);
      const newText = decodeText(newBytes);
      const stats = oldText === undefined || newText === undefined
        ? { additions: null, deletions: null }
        : lineStats(oldText, newText);
      files.push({
        path,
        previousPath: null,
        status: oldOid == null ? "A" : newOid == null ? "D" : "M",
        ...stats,
      });
      filePatches.push(filePatch(path, oldOid, newOid, oldText, newText));
    }
    const [subject = "Untitled commit", ...bodyLines] = entry.commit.message.trimEnd().split("\n");
    const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
    const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
    commits.push({
      hash: entry.oid,
      shortHash: entry.oid.slice(0, 7),
      parents: entry.commit.parent,
      author: entry.commit.author.name,
      authoredAt: new Date(entry.commit.author.timestamp * 1_000).toISOString(),
      refs: entry.oid === head ? ["HEAD -> nanocodex"] : [],
      subject,
      body: bodyLines.join("\n").trim(),
      files,
      stats: { files: files.length, additions, deletions },
    });
    patches.push(`From ${entry.oid} Mon Sep 17 00:00:00 2001\n${filePatches.join("\n")}`);
  }
  return { commits, patch: patches.join("\n") };
}

async function readBlob(
  fs: OpfsGitFs,
  oid: string,
  cache: Map<string, Uint8Array>,
): Promise<Uint8Array> {
  const retained = cache.get(oid);
  if (retained) return retained;
  const bytes = (await git.readBlob({ fs, dir: directory, oid })).blob.slice();
  cache.set(oid, bytes);
  return bytes;
}

function decodeText(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return "";
  if (bytes.includes(0)) return undefined;
  try {
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function lineStats(oldText: string, newText: string) {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(oldText, newText)) {
    if (change.added) additions += change.count ?? 0;
    if (change.removed) deletions += change.count ?? 0;
  }
  return { additions, deletions };
}

function filePatch(
  path: string,
  oldOid: string | null,
  newOid: string | null,
  oldText: string | undefined,
  newText: string | undefined,
): string {
  const oldPath = oldOid == null ? "/dev/null" : `a/${path}`;
  const newPath = newOid == null ? "/dev/null" : `b/${path}`;
  const header = [
    `diff --git a/${path} b/${path}`,
    oldOid == null ? "new file mode 100644" : newOid == null ? "deleted file mode 100644" : "",
    oldOid && newOid ? `index ${oldOid.slice(0, 7)}..${newOid.slice(0, 7)} 100644` : "",
  ].filter(Boolean).join("\n");
  if (oldText === undefined || newText === undefined) {
    return `${header}\nBinary files ${oldPath} and ${newPath} differ\n`;
  }
  const unified = createTwoFilesPatch(oldPath, newPath, oldText, newText, "", "", { context: 3 });
  return `${header}\n${unified.replace(/^={3,}\n/, "")}`;
}

function resourceUrl(blob: Blob, urls: string[]): string {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}
