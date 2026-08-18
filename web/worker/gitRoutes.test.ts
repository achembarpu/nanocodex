import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { handleGitRequest, readGitProtocolRequest } from "./gitRoutes.ts";

const head = "a".repeat(40);

test("generation-pinned commit pages bypass mutable publication state", async () => {
  let requestedKey = "";
  const bucket = {
    get: async (key: string) => {
      requestedKey = key;
      return {
        body: new Response("[]").body,
        httpEtag: '"page"',
        writeHttpMetadata: () => {},
      };
    },
  } as unknown as R2Bucket;
  const request = new Request(
    `https://nanocodex.example/api/repository/commits?page=2&generation=${head}`,
  );

  const response = await handleGitRequest(
    request,
    { GIT_OBJECTS: bucket },
    new URL(request.url),
  );

  assert.equal(response?.status, 200);
  assert.equal(requestedKey, `generations/${head}/commits/0002.json`);
  assert.equal(response?.headers.get("x-repository-generation"), head);
  assert.equal(response?.headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("repository uploads cannot overwrite an immutable R2 key", async () => {
  let putOptions: R2PutOptions | undefined;
  const existing = {
    httpEtag: '"already-stored"',
    size: 12,
  } as R2Object;
  const bucket = {
    put: async (_key: string, _body: ReadableStream, options?: R2PutOptions) => {
      putOptions = options;
      return null;
    },
    head: async () => existing,
  } as unknown as R2Bucket;
  const request = new Request(
    "https://nanocodex.example/api/git/objects/blobs/0123456789abcdef0123456789abcdef01234567",
    {
      method: "PUT",
      headers: { authorization: "Bearer mirror-token" },
      body: "replacement",
    },
  );

  const response = await handleGitRequest(
    request,
    { GIT_OBJECTS: bucket, GIT_MIRROR_TOKEN: "mirror-token" },
    new URL(request.url),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(putOptions?.onlyIf, { etagDoesNotMatch: "*" });
  assert.deepEqual(await response?.json(), {
    key: "blobs/0123456789abcdef0123456789abcdef01234567.txt",
    etag: '"already-stored"',
    size: 12,
    stored: false,
  });
});

test("Git protocol requests accept the gzip encoding used by clone clients", async () => {
  const expected = new TextEncoder().encode("0014command=fetch\n0000");
  const compressed = gzipSync(expected);
  const request = new Request("https://nanocodex.example/git/git-upload-pack", {
    method: "POST",
    headers: { "content-encoding": "gzip" },
    body: compressed,
  });

  const decoded = await readGitProtocolRequest(request);
  assert.ok(decoded instanceof Uint8Array);
  assert.deepEqual(decoded, expected);
});

test("repository reads hit edge cache before the publication Durable Object", async () => {
  const cache = new Map<string, Response>();
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async (request: Request) => cache.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          cache.set(request.url, response.clone());
        },
      },
    },
  });
  let publicationReads = 0;
  let objectReads = 0;
  const publication = {
    version: 1,
    head,
    branch: "master",
    refs: [{ name: "refs/heads/master", oid: head }],
    snapshotKey: `generations/${head}/repository.json`,
    commitsKey: `generations/${head}/commits.json`,
    inventoryKey: `generations/${head}/inventory.json`,
    packKey: `generations/${head}/repository.pack`,
    objectManifestKey: `generations/${head}/objects.json`,
    packHash: "b".repeat(40),
    publishedAt: "2026-08-17T00:00:00.000Z",
  };
  const namespace = {
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({
      fetch: async () => {
        publicationReads += 1;
        return Response.json(publication);
      },
    }),
  } as unknown as DurableObjectNamespace;
  const bucket = {
    get: async () => {
      objectReads += 1;
      return {
        body: new Response('{"tree":[]}').body,
        httpEtag: '"snapshot"',
        writeHttpMetadata: () => {},
      };
    },
  } as unknown as R2Bucket;
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as ExecutionContext;
  const request = new Request("https://nanocodex.example/api/repository/snapshot");

  try {
    const first = await handleGitRequest(
      request,
      { GIT_OBJECTS: bucket, GIT_REPOSITORY: namespace },
      new URL(request.url),
      context,
    );
    assert.equal(first?.status, 200);
    await Promise.all(pending);
    const second = await handleGitRequest(
      request,
      { GIT_OBJECTS: bucket, GIT_REPOSITORY: namespace },
      new URL(request.url),
      context,
    );
    assert.equal(second?.status, 200);
    assert.equal(publicationReads, 1);
    assert.equal(objectReads, 1);
  } finally {
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: originalCaches,
    });
  }
});
