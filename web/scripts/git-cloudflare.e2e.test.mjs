import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildGitArtifacts } from "./publish-repository.mjs";
import { handleGitRequest } from "../worker/gitRoutes.ts";

const execFileAsync = promisify(execFile);

test("stock Git clones, incrementally fetches, and deepens R2 publications", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nanocodex-git-e2e-"));
  const source = resolve(directory, "source");
  const firstOutput = resolve(directory, "publication-1");
  const secondOutput = resolve(directory, "publication-2");
  const bucket = new MemoryR2Bucket();
  const state = { publication: null };
  const transferBytes = [];
  const server = createGitServer(bucket, state, transferBytes);
  try {
    await git(["init", "-q", "-b", "main", source], directory);
    await git(["config", "user.name", "Nanocodex E2E"], source);
    await git(["config", "user.email", "e2e@nanocodex.invalid"], source);
    await writeFile(resolve(source, "large.bin"), randomBytes(512 * 1024));
    await writeFile(resolve(source, "README.md"), "# fixture\n");
    await git(["add", "."], source);
    await git(["commit", "-qm", "large root"], source);
    await git(["tag", "-a", "v1", "-m", "version one"], source);
    await writeFile(resolve(source, "README.md"), "# fixture\n\nsecond commit\n");
    await git(["add", "README.md"], source);
    await git(["commit", "-qm", "second commit"], source);
    await mkdir(resolve(source, "src"));
    await writeFile(resolve(source, "src", "main.rs"), "fn main() {}\n");
    await git(["add", "src/main.rs"], source);
    await git(["commit", "-qm", "third commit"], source);

    await mkdir(firstOutput);
    const firstHead = await git(["rev-parse", "HEAD"], source);
    const firstRefs = await readRefs(source);
    const first = await buildGitArtifacts({
      repository: source,
      temporaryDirectory: firstOutput,
      head: firstHead,
      refs: firstRefs,
      previousManifest: null,
    });
    state.publication = publication(firstHead, firstRefs, first);
    await storeArtifacts(bucket, state.publication, first);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const remote = `http://127.0.0.1:${address.port}/git`;
    const full = resolve(directory, "full");
    await git(["-c", "protocol.version=2", "clone", "-q", remote, full], directory);
    await git(["fsck", "--strict"], full);
    assert.equal(await git(["rev-parse", "HEAD"], full), firstHead);
    assert.equal(await git(["tag", "-l", "v1"], full), "v1");
    const cloneBytes = transferBytes.reduce((total, size) => total + size, 0);
    assert.ok(cloneBytes > 400_000, `expected a representative full clone, got ${cloneBytes}`);

    await writeFile(resolve(source, "src", "main.rs"), "fn main() { println!(\"small\"); }\n");
    await git(["add", "src/main.rs"], source);
    await git(["commit", "-qm", "small fourth commit"], source);
    await mkdir(secondOutput);
    const secondHead = await git(["rev-parse", "HEAD"], source);
    const secondRefs = await readRefs(source);
    const second = await buildGitArtifacts({
      repository: source,
      temporaryDirectory: secondOutput,
      head: secondHead,
      refs: secondRefs,
      previousManifest: first.manifest,
    });
    state.publication = publication(secondHead, secondRefs, second);
    await storeArtifacts(bucket, state.publication, second);

    transferBytes.length = 0;
    await git(["-c", "fetch.unpackLimit=1", "fetch", "-q", "origin"], full);
    await git(["fsck", "--strict"], full);
    assert.equal(await git(["rev-parse", "origin/main"], full), secondHead);
    const incrementalBytes = transferBytes.reduce((total, size) => total + size, 0);
    assert.ok(
      incrementalBytes < cloneBytes / 10,
      `incremental fetch sent ${incrementalBytes} bytes after ${cloneBytes}-byte clone`,
    );

    transferBytes.length = 0;
    const shallow = resolve(directory, "shallow");
    await git(["-c", "protocol.version=2", "clone", "-q", "--depth", "1", remote, shallow], directory);
    assert.equal(await git(["rev-list", "--count", "HEAD"], shallow), "1");
    assert.equal(await git(["rev-parse", "--is-shallow-repository"], shallow), "true");
    await git(["fetch", "-q", "--deepen=1", "origin", "main"], shallow);
    assert.equal(await git(["rev-list", "--count", "HEAD"], shallow), "2");
    await git(["fetch", "-q", "--unshallow", "origin", "main"], shallow);
    assert.equal(await git(["rev-list", "--count", "HEAD"], shallow), "4");
    assert.equal(await git(["rev-parse", "--is-shallow-repository"], shallow), "false");
    await git(["fsck", "--strict"], shallow);
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

function createGitServer(bucket, state, transferBytes) {
  const namespace = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => state.publication == null
        ? Response.json({ error: "not_published" }, { status: 404 })
        : Response.json(state.publication),
    }),
  };
  return createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        body,
        ...(body == null ? {} : { duplex: "half" }),
      });
      const response = await handleGitRequest(
        request,
        { GIT_OBJECTS: bucket, GIT_REPOSITORY: namespace },
        new URL(request.url),
      ) ?? new Response("not found\n", { status: 404 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      let transferred = 0;
      if (response.body != null) {
        for await (const chunk of response.body) {
          transferred += chunk.byteLength;
          if (!outgoing.write(Buffer.from(chunk))) await once(outgoing, "drain");
        }
      }
      if (incoming.url?.includes("git-upload-pack")) transferBytes.push(transferred);
      outgoing.end();
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.end(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
  });
}

class MemoryR2Bucket {
  objects = new Map();

  async putBytes(key, bytes) {
    this.objects.set(key, new Uint8Array(bytes));
  }

  async get(key) {
    const bytes = this.objects.get(key);
    if (bytes == null) return null;
    return {
      body: new Blob([bytes]).stream(),
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer,
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      writeHttpMetadata: () => {},
      httpEtag: `"${key}"`,
    };
  }

  async head(key) {
    const bytes = this.objects.get(key);
    return bytes == null ? null : { size: bytes.byteLength, httpEtag: `"${key}"` };
  }
}

async function storeArtifacts(bucket, current, artifacts) {
  await bucket.putBytes(current.packKey, await readFile(artifacts.packPath));
  await bucket.putBytes(current.objectManifestKey, await readFile(artifacts.manifestPath));
  for (const shard of artifacts.shards) await bucket.putBytes(shard.key, await readFile(shard.path));
}

function publication(head, refs, artifacts) {
  const prefix = `generations/${head}`;
  return {
    version: 1,
    head,
    branch: "main",
    refs,
    snapshotKey: `${prefix}/repository.json`,
    commitsKey: `${prefix}/commits.json`,
    inventoryKey: `${prefix}/inventory.json`,
    packKey: `${prefix}/repository.pack`,
    objectManifestKey: `${prefix}/objects.json`,
    packHash: artifacts.packHash,
    publishedAt: new Date().toISOString(),
  };
}

async function readRefs(repository) {
  const output = await git([
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(*objectname)",
    "refs/heads/main",
    "refs/tags",
  ], repository);
  return output.split("\n").filter(Boolean).map((row) => {
    const [name, oid, peeled] = row.split("\0");
    return peeled === "" ? { name, oid } : { name, oid, peeled };
  });
}

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}
