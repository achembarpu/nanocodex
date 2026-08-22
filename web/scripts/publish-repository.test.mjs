import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildCommitPatchParts,
  buildGitArtifacts,
  buildUploadPlan,
  buildRepositoryPackParts,
  isRetriableUploadError,
  isRetriableUploadStatus,
  readRemoteState,
} from "./publish-repository.mjs";

const execFileAsync = promisify(execFile);
const publisherPath = fileURLToPath(new URL("./publish-repository.mjs", import.meta.url));

test("the publisher CLI initializes its module before building a generation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nanocodex-publisher-cli-test-"));
  const repository = resolve(directory, "repo");
  const requests = [];
  let deploymentSha;
  let stalledUpload = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const body = rawBody.toString("utf8");
    requests.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      url: request.url,
    });
    if (request.method === "GET" && request.url === "/api/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ deployment_sha: deploymentSha }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/git/state") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "PUT" && request.url?.startsWith("/api/git/objects/")) {
      if (!stalledUpload) {
        stalledUpload = true;
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ size: rawBody.byteLength }));
      return;
    }
    if (request.method === "PUT" && request.url === "/api/git/publish") {
      response.writeHead(200).end();
      return;
    }
    response.writeHead(404).end();
  });
  try {
    await git(["init", "-q", "-b", "main", repository], directory);
    await git(["config", "user.name", "Nanocodex Test"], repository);
    await git(["config", "user.email", "test@nanocodex.invalid"], repository);
    await writeFile(resolve(repository, "README.md"), "# publisher fixture\n");
    await git(["add", "README.md"], repository);
    await git(["commit", "-qm", "initial fixture"], repository);
    await writeFile(resolve(repository, "README.md"), "# publisher fixture\n\nsecond commit\n");
    await git(["add", "README.md"], repository);
    await git(["commit", "-qm", "second fixture"], repository);
    for (let index = 2; index < 33; index++) {
      await writeFile(
        resolve(repository, "README.md"),
        `# publisher fixture\n\ncommit ${index}\n`,
      );
      await git(["add", "README.md"], repository);
      const subject = index === 2
        ? "perf(web): page commit patches"
        : index === 3
        ? "fix(worker): gate publications"
        : `chore: fixture ${index}`;
      await git(["commit", "-qm", subject], repository);
    }
    const head = await git(["rev-parse", "HEAD"], repository);
    await git(["branch", "private-preview"], repository);
    await git(["tag", "v0-test"], repository);
    deploymentSha = head;

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const { stdout } = await execFileAsync(process.execPath, [publisherPath], {
      env: {
        ...process.env,
        NANOCODEX_GIT_ORIGIN: `http://127.0.0.1:${address.port}`,
        NANOCODEX_GIT_TOKEN: "publisher-test-token",
        NANOCODEX_REPO: repository,
        NANOCODEX_GIT_UPLOAD_TIMEOUT_MS: "100",
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });

    assert.match(stdout, new RegExp(`Published gakonst/nanocodex ${head.slice(0, 7)}`));
    assert.equal(stalledUpload, true);
    assert.ok(requests.length > 3);
    assert.equal(requests[0]?.url, "/api/health");
    assert.equal(requests[0]?.authorization, undefined);
    assert.ok(requests.slice(1).every(
      ({ authorization }) => authorization === "Bearer publisher-test-token"
    ));
    const publicationRequest = requests.find(({ url }) => url === "/api/git/publish");
    assert.ok(publicationRequest);
    const publication = JSON.parse(publicationRequest.body);
    assert.equal(publication.expectedHead, null);
    assert.equal(publication.publication.head, head);
    assert.equal(publication.publication.branch, "master");
    assert.deepEqual(publication.publication.refs, [
      { name: "refs/heads/master", oid: head },
    ]);
    assert.equal(publication.publication.commitPatchParts.length, 2);
    assert.equal(
      publication.publication.commitPatchParts.reduce(
        (total, part) => total + part.size,
        0,
      ),
      publication.publication.commitPatchSize,
    );
    assert.ok(publication.publication.commitPatchParts.every(({ key, size }) =>
      requests.some(({ url }) => url === `/api/git/objects/${key}`) &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      size <= 4 * 1024 * 1024
    ));
    assert.equal(
      requests.some(({ url }) =>
        url === `/api/git/objects/generations/${head}/commits.diff`
      ),
      false,
    );
    const commitPatchManifestUpload = requests.find(({ url }) =>
      url === `/api/git/objects/generations/${head}/commit-patches.json`
    );
    assert.deepEqual(JSON.parse(commitPatchManifestUpload.body), {
      version: 1,
      head,
      parts: publication.publication.commitPatchParts,
      size: publication.publication.commitPatchSize,
    });
    assert.ok(publication.publication.packParts.length > 0);
    assert.equal("packKey" in publication.publication, false);
    assert.ok(publication.publication.packParts.every(({ key, size }) =>
      requests.some(({ url }) => url === `/api/git/objects/${key}`) &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      size <= 4 * 1024 * 1024
    ));
    assert.equal(requests.some(({ url }) => url?.endsWith("/repository.pack")), false);
    const snapshotUpload = requests.find(({ url }) =>
      url === `/api/git/objects/generations/${head}/repository.json`
    );
    const commitsUpload = requests.find(({ url }) =>
      url === `/api/git/objects/generations/${head}/commits.json`
    );
    const commitIndexUpload = requests.find(({ url }) =>
      url === `/api/git/objects/generations/${head}/commit-index.json`
    );
    const commitPatchBody = publication.publication.commitPatchParts
      .map(({ key }) => requests.find(({ url }) => url === `/api/git/objects/${key}`)?.body)
      .join("");
    assert.equal(JSON.parse(snapshotUpload.body).repository.branch, "master");
    const publishedCommits = JSON.parse(commitsUpload.body);
    const publishedCommitIndex = JSON.parse(commitIndexUpload.body);
    assert.equal(publishedCommitIndex.hashes.length, 33);
    assert.equal(publishedCommitIndex.scopeCounts.all, 33);
    assert.equal(publishedCommitIndex.scopeCounts.perf, 1);
    assert.equal(publishedCommitIndex.scopeCounts.fix, 1);
    assert.deepEqual(publishedCommits[0].refs, ["HEAD -> master"]);
    assert.deepEqual(
      [...commitPatchBody.matchAll(/^From ([a-f0-9]{40}) Mon Sep 17 00:00:00 2001$/gm)]
        .map((match) => match[1]),
      publishedCommits.map(({ hash }) => hash),
    );
    assert.ok(requests.some(({ url }) =>
      url === `/api/git/objects/generations/${head}/commits/0000.json`
    ));
    assert.ok(requests.some(({ url }) =>
      url === `/api/git/objects/generations/${head}/commits/0001.json`
    ));
    assert.equal(requests.some(({ url }) =>
      url === `/api/git/objects/generations/${head}/commits/0000`
    ), false);

    deploymentSha = "0".repeat(40);
    const mismatchRequestIndex = requests.length;
    await assert.rejects(
      execFileAsync(process.execPath, [publisherPath], {
        env: {
          ...process.env,
          NANOCODEX_GIT_ORIGIN: `http://127.0.0.1:${address.port}`,
          NANOCODEX_GIT_TOKEN: "publisher-test-token",
          NANOCODEX_REPO: repository,
        },
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
      new RegExp(`Cloudflare Worker revision ${"0".repeat(40)} does not match repository ${head}`),
    );
    assert.deepEqual(
      requests.slice(mismatchRequestIndex).map(({ authorization, method, url }) => ({
        authorization,
        method,
        url,
      })),
      [{ authorization: undefined, method: "GET", url: "/api/health" }],
    );
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository publication uploads only content absent from the prior inventory", () => {
  assert.deepEqual(
    buildUploadPlan(
      { blobs: ["a", "b"], patches: ["1", "2"] },
      { blobs: ["a"], patches: ["1"] },
    ),
    { blobs: ["b"], patches: ["2"] },
  );
});

test("repository packs are divided into canonical bounded upload parts", () => {
  const head = "a".repeat(40);
  const packHash = "b".repeat(40);
  const partBytes = 4 * 1024 * 1024;
  const packSize = (partBytes * 4) + 1_100_465;
  const parts = buildRepositoryPackParts(head, packHash, packSize);

  assert.equal(parts.length, 5);
  assert.equal(parts.reduce((total, part) => total + part.size, 0), packSize);
  assert.deepEqual(parts.map(({ key, offset, size }) => ({ key, offset, size })), [
    { key: `generations/${head}/packs/${packHash}/0000.pack`, offset: 0, size: partBytes },
    { key: `generations/${head}/packs/${packHash}/0001.pack`, offset: partBytes, size: partBytes },
    { key: `generations/${head}/packs/${packHash}/0002.pack`, offset: partBytes * 2, size: partBytes },
    { key: `generations/${head}/packs/${packHash}/0003.pack`, offset: partBytes * 3, size: partBytes },
    { key: `generations/${head}/packs/${packHash}/0004.pack`, offset: partBytes * 4, size: 1_100_465 },
  ]);
});

test("commit-aligned patch pages retain contiguous bounded descriptors", () => {
  const head = "a".repeat(40);
  const partBytes = 4 * 1024 * 1024;
  const pages = [
    { name: "0000", path: "/tmp/0000.diff", size: 476_879 },
    { name: "0001", path: "/tmp/0001.diff", size: 2_105_727 },
  ];
  const parts = buildCommitPatchParts(head, pages);

  assert.deepEqual(parts, [
    {
      key: `generations/${head}/commit-patches/0000.diff`,
      path: "/tmp/0000.diff",
      size: 476_879,
    },
    {
      key: `generations/${head}/commit-patches/0001.diff`,
      path: "/tmp/0001.diff",
      size: 2_105_727,
    },
  ]);
  assert.throws(
    () => buildCommitPatchParts(head, [pages[0], { ...pages[1], name: "0002" }]),
    /page 0001 is invalid/,
  );
  assert.throws(
    () => buildCommitPatchParts(head, [{ ...pages[0], size: partBytes + 1 }]),
    /page 0000 is invalid/,
  );
  assert.throws(
    () => buildCommitPatchParts(head, Array.from({ length: 257 }, (_, index) => ({
      name: String(index).padStart(4, "0"),
      path: `/tmp/${index}.diff`,
      size: 1,
    }))),
    /page count is invalid/,
  );
});

test("repository uploads retry bounded transient responses and transport failures", () => {
  for (const status of [401, 408, 425, 429, 500, 503]) {
    assert.equal(isRetriableUploadStatus(status), true, `${status} should retry`);
  }
  for (const status of [400, 403, 404, 409, 422]) {
    assert.equal(isRetriableUploadStatus(status), false, `${status} should fail`);
  }
  assert.equal(isRetriableUploadError(new TypeError("fetch failed")), true);
  assert.equal(isRetriableUploadError(new DOMException("timed out", "TimeoutError")), true);
  assert.equal(isRetriableUploadError(new Error("invalid local input")), false);
});

test("repository state reads retry a transient secret-rollout response", async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts += 1;
    assert.equal(request.headers.authorization, "Bearer mirror-token");
    if (attempts === 1) {
      response.writeHead(500, { "content-type": "text/html" });
      response.end("transient Worker rollout");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ publication: { head: "current" } }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const state = await readRemoteState(
      `http://127.0.0.1:${address.port}`,
      "mirror-token",
    );
    assert.deepEqual(state, { publication: { head: "current" } });
    assert.equal(attempts, 2);
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("invalid publication repair requires an explicit operator opt-in", async () => {
  let authorization;
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "repository publication is invalid" }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    await assert.rejects(
      readRemoteState(origin, "mirror-token"),
      /NANOCODEX_REPAIR_INVALID_PUBLICATION=1/,
    );
    assert.deepEqual(
      await readRemoteState(origin, "mirror-token", true),
      { replaceInvalid: true },
    );
    assert.equal(authorization, "Bearer mirror-token");
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("Git artifacts contain only advertised refs and reuse immutable object shards", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nanocodex-publisher-test-"));
  const repository = resolve(directory, "repo");
  const firstOutput = resolve(directory, "first");
  const secondOutput = resolve(directory, "second");
  try {
    await git(["init", "-q", "-b", "main", repository], directory);
    await git(["config", "user.name", "Nanocodex Test"], repository);
    await git(["config", "user.email", "test@nanocodex.invalid"], repository);
    await writeFile(resolve(repository, "public.txt"), "public\n");
    await git(["add", "public.txt"], repository);
    await git(["commit", "-qm", "public root"], repository);
    const firstHead = await git(["rev-parse", "HEAD"], repository);
    await git(["tag", "root"], repository);

    await git(["switch", "-qc", "hidden"], repository);
    await writeFile(resolve(repository, "secret.txt"), "not advertised\n");
    await git(["add", "secret.txt"], repository);
    await git(["commit", "-qm", "hidden work"], repository);
    const hiddenCommit = await git(["rev-parse", "HEAD"], repository);
    const hiddenBlob = await git(["rev-parse", "HEAD:secret.txt"], repository);
    await git(["switch", "-q", "main"], repository);
    await mkdir(firstOutput);

    const first = await buildGitArtifacts({
      repository,
      temporaryDirectory: firstOutput,
      head: firstHead,
      refs: [
        { name: "refs/heads/main", oid: firstHead },
        { name: "refs/tags/root", oid: firstHead },
      ],
      previousManifest: null,
    });
    assert.equal(first.manifest.objects[hiddenCommit], undefined);
    assert.equal(first.manifest.objects[hiddenBlob], undefined);
    assert.ok(first.manifest.objects[firstHead]);
    const firstPack = await readFile(first.packPath);
    assert.equal(first.packSize, firstPack.byteLength);
    assert.deepEqual(
      Buffer.concat(first.packParts.map(({ offset, size }) =>
        firstPack.subarray(offset, offset + size)
      )),
      firstPack,
    );
    const advertisedPack = await git(
      ["verify-pack", "-v", resolve(firstOutput, "repository.idx")],
      repository,
    );
    assert.equal(advertisedPack.includes(hiddenCommit), false);

    await writeFile(resolve(repository, "public.txt"), "public\nsmall update\n");
    await git(["add", "public.txt"], repository);
    await git(["commit", "-qm", "small update"], repository);
    const secondHead = await git(["rev-parse", "HEAD"], repository);
    await mkdir(secondOutput);
    const second = await buildGitArtifacts({
      repository,
      temporaryDirectory: secondOutput,
      head: secondHead,
      refs: [{ name: "refs/heads/main", oid: secondHead }],
      previousManifest: first.manifest,
    });
    assert.equal(second.manifest.objects[firstHead][1], first.manifest.objects[firstHead][1]);
    assert.equal(second.manifest.shards[0].key, first.manifest.shards[0].key);
    assert.ok(second.shards.length > 0);
    assert.ok(second.shards.every((shard) => shard.key.includes(secondHead)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}
