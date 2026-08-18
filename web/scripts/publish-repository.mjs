import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const repositoryPath = resolve(
  process.env.NANOCODEX_REPO ?? resolve(projectRoot, ".."),
);
const uploadConcurrency = 12;

if (resolve(process.argv[1] ?? "") === scriptPath) {
  await main();
}

async function main() {
  const origin = requiredEnvironment("NANOCODEX_GIT_ORIGIN").replace(/\/$/, "");
  const token = requiredEnvironment("NANOCODEX_GIT_TOKEN");
  const previous = await readRemoteState(origin, token);
  const head = await git(["rev-parse", "HEAD"]);
  if (previous?.publication?.head === head && process.env.NANOCODEX_FORCE_SYNC !== "1") {
    console.log(`Cloudflare repository is current (${head.slice(0, 7)})`);
    return;
  }

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "nanocodex-git-"));
  try {
    const dataDirectory = resolve(temporaryDirectory, "data");
    await run(process.execPath, [resolve(projectRoot, "scripts", "sync-nanocodex.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NANOCODEX_DATA_DIR: dataDirectory,
        NANOCODEX_EMIT_OBJECTS: "1",
        NANOCODEX_FORCE_SYNC: "1",
        NANOCODEX_REPO: repositoryPath,
      },
    });

    const [snapshot, commits, refs, blobNames, patchNames, commitPageNames] = await Promise.all([
      readJson(resolve(dataDirectory, "repository.json")),
      readJson(resolve(dataDirectory, "commits.json")),
      readRefs(),
      listObjectNames(resolve(dataDirectory, "blobs"), ".txt"),
      listObjectNames(resolve(dataDirectory, "patches"), ".patch"),
      listObjectNames(resolve(dataDirectory, "commit-pages"), ".json"),
    ]);
    if (snapshot.repository?.head !== head) {
      throw new Error("repository changed while its publication was being built");
    }
    const gitArtifacts = await buildGitArtifacts({
      repository: repositoryPath,
      temporaryDirectory,
      head,
      refs,
      previousManifest: previous?.objectManifest,
    });

    const inventory = {
      version: 1,
      head,
      blobs: blobNames,
      patches: patchNames,
    };
    const previousInventory = previous?.inventory ?? { blobs: [], patches: [] };
    const plan = buildUploadPlan(inventory, previousInventory);
    console.log(
      `Uploading ${plan.blobs.length} new blobs and ${plan.patches.length} new patches`,
    );
    await mapConcurrent(
      [
        ...plan.blobs.map((id) => ({
          remote: `blobs/${id}`,
          local: resolve(dataDirectory, "blobs", `${id}.txt`),
        })),
        ...plan.patches.map((id) => ({
          remote: `patches/${id}`,
          local: resolve(dataDirectory, "patches", `${id}.patch`),
        })),
      ],
      uploadConcurrency,
      ({ remote, local }) => uploadFile(origin, token, remote, local),
    );

    const generationPrefix = `generations/${head}`;
    const inventoryPath = resolve(temporaryDirectory, "inventory.json");
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`);
    await Promise.all([
      uploadFile(origin, token, `${generationPrefix}/repository.json`, resolve(dataDirectory, "repository.json")),
      uploadFile(origin, token, `${generationPrefix}/commits.json`, resolve(dataDirectory, "commits.json")),
      uploadFile(origin, token, `${generationPrefix}/inventory.json`, inventoryPath),
      uploadFile(origin, token, `${generationPrefix}/objects.json`, gitArtifacts.manifestPath),
      mapConcurrent(gitArtifacts.shards, uploadConcurrency, (shard) =>
        uploadFile(origin, token, shard.key, shard.path)
      ),
      mapConcurrent(commitPageNames, uploadConcurrency, (name) => uploadFile(
          origin,
          token,
          `${generationPrefix}/commits/${name}`,
          resolve(dataDirectory, "commit-pages", `${name}.json`),
        )),
    ]);
    await uploadFile(origin, token, `${generationPrefix}/repository.pack`, gitArtifacts.packPath);

    const publication = {
      version: 1,
      head,
      branch: snapshot.repository.branch,
      refs,
      snapshotKey: `${generationPrefix}/repository.json`,
      commitsKey: `${generationPrefix}/commits.json`,
      inventoryKey: `${generationPrefix}/inventory.json`,
      packKey: `${generationPrefix}/repository.pack`,
      objectManifestKey: `${generationPrefix}/objects.json`,
      packHash: gitArtifacts.packHash,
      publishedAt: new Date().toISOString(),
    };
    const response = await authenticatedFetch(`${origin}/api/git/publish`, token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedHead: previous?.publication?.head ?? null,
        publication,
      }),
    });
    if (!response.ok) throw new Error(await responseError("publish", response));
    console.log(
      `Published ${snapshot.repository.fullName} ${head.slice(0, 7)} (${commits.length} commits, ${gitArtifacts.objectCount} objects, ${gitArtifacts.packHash.slice(0, 7)} pack)`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function buildUploadPlan(inventory, previousInventory) {
  const previousBlobs = new Set(previousInventory.blobs ?? []);
  const previousPatches = new Set(previousInventory.patches ?? []);
  return {
    blobs: inventory.blobs.filter((id) => !previousBlobs.has(id)),
    patches: inventory.patches.filter((id) => !previousPatches.has(id)),
  };
}

async function readRemoteState(origin, token) {
  const response = await authenticatedFetch(`${origin}/api/git/state`, token);
  if (response.status === 503 || response.status === 404) return null;
  if (!response.ok) throw new Error(await responseError("read state", response));
  return response.json();
}

const objectShardTargetBytes = 4 * 1024 * 1024;
const objectShardCompactionThreshold = 128;
const gitObjectTypes = { commit: 1, tree: 2, blob: 3, tag: 4 };

export async function buildGitArtifacts({
  repository,
  temporaryDirectory,
  head,
  refs,
  previousManifest,
}) {
  const revisionOids = [...new Set(refs.map((ref) => ref.oid))];
  if (revisionOids.length === 0 || !revisionOids.includes(head)) {
    throw new Error("published Git refs do not contain HEAD");
  }

  const packPath = resolve(temporaryDirectory, "repository.pack");
  const indexPath = resolve(temporaryDirectory, "repository.idx");
  await writePack(packPath, revisionOids, repository, true);
  const packHash = await indexAndVerifyPack(packPath, indexPath, repository);
  const reachableOids = await listReachableOids(revisionOids, repository);

  const reusePrevious = isReusableManifest(previousManifest) &&
    previousManifest.shards.length < objectShardCompactionThreshold;
  const shards = reusePrevious ? previousManifest.shards.map((shard) => ({ ...shard })) : [];
  const objects = {};
  const newOids = [];
  for (const oid of reachableOids) {
    const previous = reusePrevious ? previousManifest.objects[oid] : undefined;
    if (isReusableObjectRecord(previous, shards)) objects[oid] = previous;
    else newOids.push(oid);
  }

  const newShards = newOids.length === 0
    ? []
    : await buildObjectShards({
        repository,
        temporaryDirectory,
        head,
        objectIds: newOids,
        firstShardIndex: shards.length,
        objects,
      });
  shards.push(...newShards.map(({ key, size }) => ({ key, size })));

  for (const [oid, record] of Object.entries(objects)) {
    for (const dependency of record[4]) {
      if (objects[dependency] == null) {
        throw new Error(`Git object ${oid} depends on unpublished object ${dependency}`);
      }
    }
  }
  if (objects[head] == null || Object.keys(objects).length !== reachableOids.length) {
    throw new Error("Git object manifest is incomplete");
  }

  const manifest = { version: 1, head, shards, objects };
  const manifestPath = resolve(temporaryDirectory, "objects.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  return {
    packPath,
    packHash,
    manifest,
    manifestPath,
    shards: newShards.map(({ key, path }) => ({ key, path })),
    objectCount: reachableOids.length,
  };
}

async function writePack(path, objectIds, repository, traverseRevisions) {
  const args = ["pack-objects", "--stdout"];
  if (traverseRevisions) args.push("--revs");
  else args.push("--window=0", "--depth=0", "--no-reuse-delta", "--no-reuse-object");
  const child = spawn("git", args, {
    cwd: repository,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${objectIds.join("\n")}\n`);
  await Promise.all([
    pipeline(child.stdout, createWriteStream(path, { flags: "wx" })),
    new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolveExit();
        else reject(new Error(stderr.trim() || `git pack-objects exited with ${code}`));
      });
    }),
  ]);
}

async function indexAndVerifyPack(packPath, indexPath, repository) {
  const { stdout } = await execFileAsync(
    "git",
    ["index-pack", "--index-version=2", "-o", indexPath, packPath],
    { cwd: repository, encoding: "utf8" },
  );
  const hash = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(hash)) {
    throw new Error(`git index-pack returned an invalid hash: ${hash}`);
  }
  await execFileAsync("git", ["verify-pack", "-s", indexPath], {
    cwd: repository,
    encoding: "utf8",
  });
  return hash;
}

async function listReachableOids(revisionOids, repository) {
  const output = await gitWithInput(
    ["rev-list", "--objects", "--no-object-names", "--stdin"],
    `${revisionOids.join("\n")}\n`,
    repository,
  );
  const objectIds = [...new Set(output.toString("utf8").trim().split("\n").filter(Boolean))];
  if (objectIds.some((oid) => !/^[a-f0-9]{40}$/.test(oid))) {
    throw new Error("git rev-list returned an invalid object id");
  }
  return objectIds;
}

async function buildObjectShards({
  repository,
  temporaryDirectory,
  head,
  objectIds,
  firstShardIndex,
  objects,
}) {
  const objectPackPath = resolve(temporaryDirectory, "new-objects.pack");
  const objectIndexPath = resolve(temporaryDirectory, "new-objects.idx");
  await writePack(objectPackPath, objectIds, repository, false);
  await indexAndVerifyPack(objectPackPath, objectIndexPath, repository);
  const entries = await readPackEntries(objectIndexPath, repository);
  if (entries.length !== objectIds.length) {
    throw new Error(`Git object pack contains ${entries.length} objects, expected ${objectIds.length}`);
  }
  const dependencies = await readObjectDependencies(entries, repository);
  const handle = await open(objectPackPath, "r");
  const shards = [];
  try {
    for (let entryIndex = 0; entryIndex < entries.length;) {
      const shardEntries = [];
      let shardSize = 0;
      while (entryIndex < entries.length) {
        const entry = entries[entryIndex];
        if (shardSize > 0 && shardSize + entry.length > objectShardTargetBytes) break;
        shardEntries.push(entry);
        shardSize += entry.length;
        entryIndex += 1;
      }
      const number = firstShardIndex + shards.length;
      if (number > 9_999) throw new Error("Git object shard count exceeds 9999");
      const name = `${String(number).padStart(4, "0")}.pack`;
      const path = resolve(temporaryDirectory, `objects-${name}`);
      const contents = Buffer.allocUnsafe(shardSize);
      const { bytesRead } = await handle.read(contents, 0, shardSize, shardEntries[0].offset);
      if (bytesRead !== shardSize) throw new Error("Git object pack ended inside an entry shard");
      await writeFile(path, contents);
      const shardIndex = number;
      let offset = 0;
      for (const entry of shardEntries) {
        objects[entry.oid] = [
          entry.type,
          shardIndex,
          offset,
          entry.length,
          dependencies.get(entry.oid) ?? [],
        ];
        offset += entry.length;
      }
      shards.push({
        key: `generations/${head}/objects/${name}`,
        path,
        size: shardSize,
      });
    }
  } finally {
    await handle.close();
  }
  return shards;
}

async function readPackEntries(indexPath, repository) {
  const { stdout } = await execFileAsync("git", ["verify-pack", "-v", indexPath], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (!/^[a-f0-9]{40}$/.test(fields[0] ?? "")) continue;
    const type = gitObjectTypes[fields[1]];
    const length = Number(fields[3]);
    const offset = Number(fields[4]);
    if (
      type == null ||
      fields.length !== 5 ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 12
    ) {
      throw new Error(`Git object entry is not a complete non-delta object: ${line}`);
    }
    entries.push({ oid: fields[0], type, length, offset });
  }
  entries.sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1].offset + entries[index - 1].length !== entries[index].offset) {
      throw new Error("Git object pack entries are not contiguous");
    }
  }
  return entries;
}

async function readObjectDependencies(entries, repository) {
  const structural = entries.filter((entry) => entry.type !== gitObjectTypes.blob);
  if (structural.length === 0) return new Map();
  const output = await gitWithInput(
    ["cat-file", "--batch"],
    `${structural.map((entry) => entry.oid).join("\n")}\n`,
    repository,
    512 * 1024 * 1024,
  );
  const dependencies = new Map();
  let offset = 0;
  for (const expected of structural) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("git cat-file returned a truncated header");
    const header = output.subarray(offset, newline).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (header[0] !== expected.oid || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("git cat-file returned an unexpected object");
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length) throw new Error("git cat-file returned truncated object data");
    const body = output.subarray(start, end);
    dependencies.set(expected.oid, parseObjectDependencies(expected.type, body));
    offset = end + 1;
  }
  return dependencies;
}

function parseObjectDependencies(type, body) {
  if (type === gitObjectTypes.commit) {
    const dependencies = [];
    for (const line of body.toString("utf8").split("\n")) {
      if (line === "") break;
      if (line.startsWith("tree ")) dependencies.unshift(line.slice(5));
      else if (line.startsWith("parent ")) dependencies.push(line.slice(7));
    }
    return dependencies;
  }
  if (type === gitObjectTypes.tag) {
    const target = body.toString("utf8").match(/^object ([a-f0-9]{40})$/m)?.[1];
    return target == null ? [] : [target];
  }
  if (type !== gitObjectTypes.tree) return [];
  const dependencies = [];
  for (let offset = 0; offset < body.length;) {
    const space = body.indexOf(0x20, offset);
    const nul = body.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > body.length) {
      throw new Error("Git tree object is malformed");
    }
    const mode = body.subarray(offset, space).toString("ascii");
    if (mode !== "160000") dependencies.push(body.subarray(nul + 1, nul + 21).toString("hex"));
    offset = nul + 21;
  }
  return dependencies;
}

function isReusableManifest(value) {
  return value != null &&
    value.version === 1 &&
    Array.isArray(value.shards) &&
    value.shards.length > 0 &&
    value.shards.every((shard) =>
      shard != null &&
      /^generations\/[a-f0-9]{40}\/objects\/\d{4}\.pack$/.test(shard.key) &&
      Number.isSafeInteger(shard.size) &&
      shard.size > 0
    ) &&
    value.objects != null &&
    typeof value.objects === "object";
}

function isReusableObjectRecord(value, shards) {
  return Array.isArray(value) &&
    value.length === 5 &&
    Object.values(gitObjectTypes).includes(value[0]) &&
    Number.isSafeInteger(value[1]) &&
    value[1] >= 0 &&
    value[1] < shards.length &&
    Number.isSafeInteger(value[2]) &&
    value[2] >= 0 &&
    Number.isSafeInteger(value[3]) &&
    value[3] > 0 &&
    value[2] + value[3] <= shards[value[1]].size &&
    Array.isArray(value[4]) &&
    value[4].every((oid) => /^[a-f0-9]{40}$/.test(oid));
}

async function gitWithInput(args, input, repository, maximumBytes = 64 * 1024 * 1024) {
  const child = spawn("git", args, { cwd: repository, stdio: ["pipe", "pipe", "pipe"] });
  const chunks = [];
  let bytes = 0;
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > maximumBytes) child.kill("SIGKILL");
    else chunks.push(chunk);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  if (bytes > maximumBytes) throw new Error(`git ${args[0]} output exceeded ${maximumBytes} bytes`);
  if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} exited with ${code}`);
  return Buffer.concat(chunks, bytes);
}

async function readRefs() {
  const output = await git([
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(*objectname)",
    "refs/heads",
    "refs/tags",
  ]);
  return output.split("\n").filter(Boolean).map((row) => {
    const [name, oid, peeled] = row.split("\0");
    if (
      !name ||
      !/^[a-f0-9]{40}$/.test(oid ?? "") ||
      (peeled !== "" && !/^[a-f0-9]{40}$/.test(peeled ?? ""))
    ) {
      throw new Error(`invalid Git ref row: ${row}`);
    }
    return peeled === "" ? { name, oid } : { name, oid, peeled };
  });
}

async function uploadFile(origin, token, remote, local) {
  const size = (await stat(local)).size;
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const headers = new Headers({ "content-length": String(size) });
    const body = Readable.toWeb(createReadStream(local));
    const response = await authenticatedFetch(
      `${origin}/api/git/objects/${remote}`,
      token,
      { method: "PUT", headers, body, duplex: "half" },
    );
    if (response.ok) return;
    lastError = new Error(await responseError(`upload ${basename(local)}`, response));
    if (!isRetriableUploadStatus(response.status) || attempt === 5) break;
    await delay(250 * (2 ** (attempt - 1)));
  }
  throw lastError;
}

export function isRetriableUploadStatus(status) {
  return status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function authenticatedFetch(url, token, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

async function responseError(operation, response) {
  return `${operation} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`;
}

async function listObjectNames(path, suffix) {
  return (await readdir(path))
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.slice(0, -suffix.length))
    .sort();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function mapConcurrent(values, concurrency, operation) {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      await operation(values[index], index);
    }
  }));
}

async function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: "inherit" });
  await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveExit();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function git(args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
