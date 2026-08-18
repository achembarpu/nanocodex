import { execFile, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import type { Plugin } from "vite";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryPath = resolve(
  process.env.NANOCODEX_REPO ?? resolve(projectRoot, ".."),
);
const endpointPrefix = "/__nanocodex/repository";
const commitPageSize = 32;
const logFormat = "%x1e%H%x00%h%x00%P%x00%an%x00%aI%x00%D%x00%s%x00%b%x00";

type CommitHeader = {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authoredAt: string;
  refs: string[];
  subject: string;
  body: string;
};

type ChangedFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
};

type LogRecord = {
  header: CommitHeader;
  payload: string;
};

const projectPath = relative(repositoryPath, projectRoot).replaceAll("\\", "/");
const projectIsInRepository =
  projectPath === "" ||
  (projectPath !== ".." && !projectPath.startsWith("../"));
const projectPrefix = projectPath === "" ? "" : `${projectPath}/`;
const generatedDataPrefixes = projectIsInRepository
  ? [`${projectPrefix}public/data/`, `${projectPrefix}src/data/`]
  : [];
const sourcePathspec = [
  ".",
  ...generatedDataPrefixes.map((prefix) => `:(exclude)${prefix}**`),
];

export function repositoryDevServer(): Plugin {
  let allowedFiles = new Set<string>();

  return {
    name: "nanocodex-repository-dev-server",
    apply: "serve",
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "https://localhost");
        if (!url.pathname.startsWith(endpointPrefix)) {
          next();
          return;
        }
        if (request.method !== "GET") {
          response.writeHead(405).end();
          return;
        }

        try {
          if (url.pathname === `${endpointPrefix}/snapshot`) {
            const snapshot = await buildRepositorySnapshot();
            allowedFiles = new Set(snapshot.tree.map((file) => file.path));
            sendJson(response, snapshot);
            return;
          }
          if (url.pathname === `${endpointPrefix}/commits`) {
            const commits = await buildCommitMetadata();
            const rawPage = url.searchParams.get("page");
            if (rawPage == null) {
              sendJson(response, commits);
              return;
            }
            if (!/^\d+$/.test(rawPage)) {
              response.writeHead(400).end();
              return;
            }
            const page = Number(rawPage);
            sendJson(
              response,
              commits.slice(page * commitPageSize, (page + 1) * commitPageSize),
            );
            return;
          }
          if (url.pathname === `${endpointPrefix}/file`) {
            await sendWorkingTreeFile(url.searchParams.get("path"), allowedFiles, response);
            return;
          }
          if (url.pathname === `${endpointPrefix}/commits.diff`) {
            await streamCommitPatch(
              url.searchParams.get("hash"),
              request,
              response,
            );
            return;
          }
          response.writeHead(404).end();
        } catch (error) {
          vite.config.logger.error(
            `Repository development service failed: ${safeMessage(error)}`,
          );
          if (!response.headersSent) response.writeHead(500);
          response.end();
        }
      });
    },
  };
}

async function buildRepositorySnapshot() {
  const [
    head,
    branch,
    remote,
    totalCommits,
    dirtyStatus,
    trackedFiles,
    stagedFiles,
  ] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["branch", "--show-current"]),
    git(["remote", "get-url", "origin"], true),
    git(["rev-list", "--count", "HEAD"]),
    git(["status", "--porcelain"], true),
    git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
    git(["ls-files", "--stage", "-z"]),
  ]);

  const staged = parseStagedFiles(stagedFiles);
  const paths = trackedFiles
    .split("\0")
    .filter(Boolean)
    .filter((path) => !isGeneratedData(path));
  const tree = (
    await Promise.all(
      paths.map(async (path) => {
        const absolutePath = resolveRepositoryFile(path);
        try {
          const metadata = await lstat(absolutePath);
          const stagedFile = staged.get(path);
          const viewable = metadata.isFile();
          return {
            path,
            mode: stagedFile?.mode ?? (metadata.mode & 0o111 ? "100755" : "100644"),
            objectId: [
              stagedFile?.objectId ?? "worktree",
              Math.trunc(metadata.mtimeMs),
              metadata.size,
            ].join(":"),
            size: metadata.size,
            contentUrl: viewable
              ? `${endpointPrefix}/file?path=${encodeURIComponent(path)}`
              : null,
          };
        } catch {
          return null;
        }
      }),
    )
  ).filter((file): file is NonNullable<typeof file> => file !== null);
  tree.sort((left, right) => left.path.localeCompare(right.path));

  const dirtyRows = dirtyStatus.split("\n").filter(Boolean);

  return {
    repository: {
      ...parseRepositoryIdentity(remote),
      branch: branch || "detached",
      head,
      totalCommits: Number(totalCommits),
      indexedCommits: Number(totalCommits),
      commitPageSize,
      dirty: dirtyRows.length > 0,
      dirtyCount: dirtyRows.length,
    },
    generatedAt: new Date().toISOString(),
    tree,
  };
}

async function buildCommitMetadata() {
  const [numstatLog, statusLog] = await Promise.all([
    git(["log", `--format=${logFormat}`, "--numstat", "-z", "--find-renames"]),
    git(["log", `--format=${logFormat}`, "--name-status", "-z", "--find-renames"]),
  ]);
  return combineCommitLogs(numstatLog, statusLog);
}

function combineCommitLogs(numstatLog: string, statusLog: string) {
  const statuses = new Map(
    parseLogRecords(statusLog).map(({ header, payload }) => [
      header.hash,
      parseStatuses(payload),
    ]),
  );

  return parseLogRecords(numstatLog).map(({ header, payload }) => {
    const statusByPath = statuses.get(header.hash) ?? new Map();
    const files = parseNumstat(payload).map((file) => ({
      ...file,
      status: statusByPath.get(file.path)?.status ?? "M",
      previousPath:
        statusByPath.get(file.path)?.previousPath ?? file.previousPath,
    }));
    return {
      ...header,
      files,
      stats: {
        files: files.length,
        additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
        deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
      },
    };
  });
}

function parseLogRecords(output: string): LogRecord[] {
  return output
    .split("\x1e")
    .filter(Boolean)
    .map((record) => {
      const fields: string[] = [];
      let cursor = 0;
      for (let index = 0; index < 8; index += 1) {
        const end = record.indexOf("\0", cursor);
        if (end < 0) throw new Error("Could not parse Git log metadata");
        fields.push(record.slice(cursor, end));
        cursor = end + 1;
      }
      const [hash, shortHash, parentField, author, authoredAt, refField, subject, body] =
        fields;
      return {
        header: {
          hash,
          shortHash,
          parents: parentField.split(" ").filter(Boolean),
          author,
          authoredAt,
          refs: refField.split(",").map((ref) => ref.trim()).filter(Boolean),
          subject,
          body: body.trim(),
        },
        payload: record.slice(cursor).replace(/^[\0\r\n]+/, ""),
      };
    });
}

function parseNumstat(payload: string): Array<Omit<ChangedFile, "status">> {
  const tokens = payload.split("\0");
  const files: Array<Omit<ChangedFile, "status">> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/^[\r\n]+/, "");
    const match = token.match(/^([^\t]+)\t([^\t]+)\t([\s\S]*)$/);
    if (!match) continue;
    const [, rawAdditions, rawDeletions, inlinePath] = match;
    const previousPath = inlinePath === "" ? tokens[++index] ?? null : null;
    const path = inlinePath === "" ? tokens[++index] ?? "" : inlinePath;
    if (!path || isGeneratedData(path)) continue;
    files.push({
      path,
      previousPath,
      additions: rawAdditions === "-" ? null : Number(rawAdditions),
      deletions: rawDeletions === "-" ? null : Number(rawDeletions),
    });
  }
  return files;
}

function parseStatuses(payload: string) {
  const tokens = payload.split("\0");
  const statuses = new Map<string, { status: string; previousPath: string | null }>();
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index].replace(/^[\r\n]+/, "");
    if (!/^[A-Z]/.test(status)) continue;
    const previousPath = status.startsWith("R") || status.startsWith("C")
      ? tokens[++index] ?? null
      : null;
    const path = tokens[++index] ?? "";
    if (!path || isGeneratedData(path)) continue;
    statuses.set(path, { status: status[0], previousPath });
  }
  return statuses;
}

function parseStagedFiles(output: string) {
  const staged = new Map<string, { mode: string; objectId: string }>();
  for (const row of output.split("\0").filter(Boolean)) {
    const separator = row.indexOf("\t");
    if (separator < 0) continue;
    const [mode, objectId] = row.slice(0, separator).split(" ");
    staged.set(row.slice(separator + 1), { mode, objectId });
  }
  return staged;
}

async function sendWorkingTreeFile(
  path: string | null,
  allowedFiles: ReadonlySet<string>,
  response: ServerResponse,
): Promise<void> {
  if (path == null || !allowedFiles.has(path)) {
    response.writeHead(404).end();
    return;
  }
  const contents = await readFile(resolveRepositoryFile(path));
  if (!isText(contents)) {
    response.writeHead(415).end();
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(contents);
}

async function streamCommitPatch(
  hash: string | null,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (hash == null || !/^[a-f0-9]{40}$/.test(hash)) {
    response.writeHead(400).end();
    return;
  }
  try {
    await git(["cat-file", "-e", `${hash}^{commit}`]);
  } catch {
    response.writeHead(404).end();
    return;
  }
  const etag = `"${hash}"`;
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { ETag: etag }).end();
    return;
  }
  const child = spawn(
    "git",
    [
      "show",
      "--format=From %H Mon Sep 17 00:00:00 2001",
      "--first-parent",
      "-p",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      "--find-copies",
      "--unified=3",
      hash,
      "--",
      ...sourcePathspec,
    ],
    { cwd: repositoryPath, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error) => response.destroy(error));
  child.once("close", (code) => {
    if (code !== 0 && !response.destroyed) {
      response.destroy(new Error(stderr.trim() || `git show exited with ${code}`));
    }
  });
  const acceptsGzip = /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-cache",
    "Content-Type": "text/plain; charset=utf-8",
    ETag: etag,
    Vary: "Accept-Encoding",
  };
  if (acceptsGzip) headers["Content-Encoding"] = "gzip";
  response.writeHead(200, headers);
  if (acceptsGzip) {
    const gzip = createGzip();
    gzip.once("error", (error) => response.destroy(error));
    child.stdout.pipe(gzip).pipe(response);
  } else {
    child.stdout.pipe(response);
  }
  response.once("close", () => {
    if (!response.writableEnded) child.kill();
  });
  request.once("aborted", () => child.kill());
}

function resolveRepositoryFile(path: string): string {
  const absolutePath = resolve(repositoryPath, path);
  const prefix = repositoryPath.endsWith(sep) ? repositoryPath : `${repositoryPath}${sep}`;
  if (!absolutePath.startsWith(prefix)) throw new Error("Invalid repository path");
  return absolutePath;
}

function isGeneratedData(path: string): boolean {
  return generatedDataPrefixes.some((prefix) => path.startsWith(prefix));
}

function isText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlBytes += 1;
  }
  return sample.length === 0 || controlBytes / sample.length < 0.02;
}

function parseRepositoryIdentity(remote: string) {
  const match = remote.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  return { fullName: match ? `${match[1]}/${match[2]}` : "gakonst/nanocodex" };
}

async function git(args: string[], optional = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (error) {
    if (optional) return "";
    throw error;
  }
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
