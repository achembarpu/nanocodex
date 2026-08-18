import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildGitArtifacts,
  buildUploadPlan,
  isRetriableUploadStatus,
} from "./publish-repository.mjs";

const execFileAsync = promisify(execFile);
const publisherPath = fileURLToPath(new URL("./publish-repository.mjs", import.meta.url));

test("the publisher CLI initializes its module before building a generation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nanocodex-publisher-cli-test-"));
  const repository = resolve(directory, "repo");
  const requests = [];
  let deploymentSha;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
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
      response.writeHead(201).end();
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
    const head = await git(["rev-parse", "HEAD"], repository);
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
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });

    assert.match(stdout, new RegExp(`Published gakonst/nanocodex ${head.slice(0, 7)}`));
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
    assert.ok(requests.some(({ url }) =>
      url === `/api/git/objects/generations/${head}/commits/0000.json`
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

test("repository uploads retry only transient and secret-propagation responses", () => {
  for (const status of [401, 408, 425, 429, 500, 503]) {
    assert.equal(isRetriableUploadStatus(status), true, `${status} should retry`);
  }
  for (const status of [400, 403, 404, 409, 422]) {
    assert.equal(isRetriableUploadStatus(status), false, `${status} should fail`);
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
