import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { handleGitRequest, readGitProtocolRequest } from "./gitRoutes.ts";

const head = "a".repeat(40);
const packHash = "b".repeat(40);

function commitPatchManifest(publication: {
  head: string;
  commitPatchParts: Array<{ key: string; size: number }>;
  commitPatchSize: number;
}) {
  return {
    version: 1 as const,
    head: publication.head,
    parts: publication.commitPatchParts,
    size: publication.commitPatchSize,
  };
}

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

test("generation-pinned commit patch pages bypass mutable publication state", async () => {
  let requestedKey = "";
  const bucket = {
    get: async (key: string) => {
      requestedKey = key;
      return {
        body: new Response(`From ${head} Mon Sep 17 00:00:00 2001\n`).body,
        httpEtag: '"patch-page"',
        writeHttpMetadata: () => {},
      };
    },
  } as unknown as R2Bucket;
  const request = new Request(
    `https://nanocodex.example/api/repository/commits/${head}/0002.diff`,
  );

  const response = await handleGitRequest(
    request,
    { GIT_OBJECTS: bucket },
    new URL(request.url),
  );

  assert.equal(response?.status, 200);
  assert.equal(requestedKey, `generations/${head}/commit-patches/0002.diff`);
  assert.equal(response?.headers.get("x-repository-generation"), head);
  assert.equal(response?.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response?.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("patch text bypasses cached legacy representations without changing its public URL", async () => {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const cached = new Map<string, Response>([[
    `https://nanocodex.example/api/repository/commits/${head}/0002.diff`,
    new Response("legacy", { headers: { "content-type": "text/x-diff" } }),
  ]]);
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async (request: Request) => cached.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          cached.set(request.url, response.clone());
        },
      },
    },
  });
  let objectReads = 0;
  const bucket = {
    get: async () => {
      objectReads += 1;
      return {
        body: new Response("current").body,
        httpEtag: '"patch-page"',
        writeHttpMetadata: () => {},
      };
    },
  } as unknown as R2Bucket;
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as ExecutionContext;
  const request = new Request(
    `https://nanocodex.example/api/repository/commits/${head}/0002.diff`,
  );

  try {
    const first = await handleGitRequest(
      request,
      { GIT_OBJECTS: bucket },
      new URL(request.url),
      context,
    );
    assert.equal(await first?.text(), "current");
    assert.equal(first?.headers.get("content-type"), "text/plain; charset=utf-8");
    await Promise.all(pending);
    assert.ok(cached.has(`${request.url}?__nanocodex_patch=text`));

    const second = await handleGitRequest(
      request,
      { GIT_OBJECTS: bucket },
      new URL(request.url),
      context,
    );
    assert.equal(await second?.text(), "current");
    assert.equal(objectReads, 1);
  } finally {
    Object.defineProperty(globalThis, "caches", originalCaches ?? {
      configurable: true,
      value: undefined,
    });
  }
});

test("generation-pinned aggregate commit patches stream immutable R2 bodies without mutable state", async () => {
  const firstPart = new Uint8Array(16 * 1024 * 1024);
  const finalPart = new TextEncoder().encode(
    `From ${head} Mon Sep 17 00:00:00 2001\n`,
  );
  const partKeys = [
    `generations/${head}/commit-patches/0000.diff`,
    `generations/${head}/commit-patches/0001.diff`,
  ];
  const objects = new Map([
    [partKeys[0], firstPart],
    [partKeys[1], finalPart],
  ]);
  const publication = {
    version: 1 as const,
    head,
    branch: "master",
    refs: [{ name: "refs/heads/master", oid: head }],
    snapshotKey: `generations/${head}/repository.json`,
    commitsKey: `generations/${head}/commits.json`,
    commitPatchParts: partKeys.map((key) => ({ key, size: objects.get(key)!.byteLength })),
    commitPatchSize: firstPart.byteLength + finalPart.byteLength,
    inventoryKey: `generations/${head}/inventory.json`,
    packParts: [{ key: `generations/${head}/packs/${packHash}/0000.pack`, size: 1 }],
    packSize: 1,
    objectManifestKey: `generations/${head}/objects.json`,
    packHash,
    publishedAt: "2026-08-18T00:00:00.000Z",
  };
  const requestedKeys: string[] = [];
  let manifestReads = 0;
  const bucket = {
    head: async (key: string) => {
      const bytes = objects.get(key);
      return bytes == null ? null : { size: bytes.byteLength };
    },
    get: async (key: string) => {
      if (key === `generations/${head}/commit-patches.json`) {
        manifestReads += 1;
        return { json: async () => commitPatchManifest(publication) };
      }
      requestedKeys.push(key);
      const bytes = objects.get(key);
      if (bytes == null) return null;
      return {
        body: new Blob([bytes]).stream(),
        size: bytes.byteLength,
      };
    },
  } as unknown as R2Bucket;
  const request = new Request(
    `https://nanocodex.example/api/repository/commits/${head}.diff`,
  );

  const response = await handleGitRequest(
    request,
    { GIT_OBJECTS: bucket },
    new URL(request.url),
  );

  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("x-repository-generation"), head);
  assert.equal(response?.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response?.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response?.headers.get("content-length"), String(publication.commitPatchSize));
  const body = new Uint8Array(await response!.arrayBuffer());
  assert.equal(manifestReads, 1);
  assert.deepEqual(requestedKeys, partKeys);
  assert.equal(body.byteLength, publication.commitPatchSize);
  assert.equal(body.subarray(0, firstPart.byteLength).every((byte) => byte === 0), true);
  assert.equal(
    new TextDecoder().decode(body.subarray(firstPart.byteLength)),
    new TextDecoder().decode(finalPart),
  );

  const invalid = new Request(
    "https://nanocodex.example/api/repository/commits/not-a-generation.diff",
  );
  const invalidResponse = await handleGitRequest(
    invalid,
    { GIT_OBJECTS: bucket },
    new URL(invalid.url),
  );
  assert.equal(invalidResponse?.status, 400);
});

test("repository uploads cannot overwrite an immutable R2 key", async () => {
  let bodyCancelled = false;
  let putCalled = false;
  const existing = {
    httpEtag: '"already-stored"',
    size: 1_639_731,
  } as R2Object;
  const bucket = {
    head: async () => existing,
    put: async () => {
      putCalled = true;
      throw new Error("existing immutable objects must not enter R2.put");
    },
  } as unknown as R2Bucket;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(existing.size));
      controller.close();
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "PUT",
    headers: { authorization: "Bearer mirror-token" },
    body,
    duplex: "half",
  };
  const request = new Request(
    "https://nanocodex.example/api/git/objects/blobs/0123456789abcdef0123456789abcdef01234567",
    init,
  );

  const response = await handleGitRequest(
    request,
    { GIT_OBJECTS: bucket, GIT_MIRROR_TOKEN: "mirror-token" },
    new URL(request.url),
  );

  assert.equal(response?.status, 200);
  assert.equal(putCalled, false);
  assert.equal(bodyCancelled, true);
  assert.deepEqual(await response?.json(), {
    key: "blobs/0123456789abcdef0123456789abcdef01234567.txt",
    etag: '"already-stored"',
    size: existing.size,
    stored: false,
  });
});

test("repository uploads retain conditional creation for a new immutable key", async () => {
  let storedKey = "";
  let putOptions: R2PutOptions | undefined;
  let uploadedBody = "";
  const created = {
    httpEtag: '"created"',
    size: 7,
  } as R2Object;
  const bucket = {
    head: async () => null,
    put: async (key: string, body: ReadableStream, options?: R2PutOptions) => {
      storedKey = key;
      putOptions = options;
      uploadedBody = await new Response(body).text();
      return created;
    },
  } as unknown as R2Bucket;
  const request = new Request(
    `https://nanocodex.example/api/git/objects/generations/${head}/commit-patches/0000.diff`,
    {
      method: "PUT",
      headers: { authorization: "Bearer mirror-token" },
      body: "created",
    },
  );

  const response = await handleGitRequest(
    request,
    { GIT_OBJECTS: bucket, GIT_MIRROR_TOKEN: "mirror-token" },
    new URL(request.url),
  );

  assert.equal(response?.status, 200);
  assert.equal(storedKey, `generations/${head}/commit-patches/0000.diff`);
  assert.equal(uploadedBody, "created");
  assert.deepEqual(putOptions?.onlyIf, { etagDoesNotMatch: "*" });
  assert.deepEqual(await response?.json(), {
    key: `generations/${head}/commit-patches/0000.diff`,
    etag: '"created"',
    size: 7,
    stored: true,
  });
});

test("repository publication forwards an explicit invalid-state replacement", async () => {
  const shardKey = `generations/${head}/objects/0000.pack`;
  const publication = {
    version: 1 as const,
    head,
    branch: "master",
    refs: [{ name: "refs/heads/master", oid: head }],
    snapshotKey: `generations/${head}/repository.json`,
    commitsKey: `generations/${head}/commits.json`,
    commitPatchParts: [{
      key: `generations/${head}/commit-patches/0000.diff`,
      size: 1,
    }],
    commitPatchSize: 1,
    inventoryKey: `generations/${head}/inventory.json`,
    packParts: [{ key: `generations/${head}/packs/${packHash}/0000.pack`, size: 1 }],
    packSize: 1,
    objectManifestKey: `generations/${head}/objects.json`,
    packHash,
    publishedAt: "2026-08-18T00:00:00.000Z",
  };
  const manifest = {
    version: 1,
    head,
    shards: [{ key: shardKey, size: 1 }],
    objects: { [head]: [1, 0, 0, 1, []] },
  };
  let forwarded: unknown;
  const namespace = {
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwarded = JSON.parse(String(init?.body));
        return Response.json(publication);
      },
    }),
  } as unknown as DurableObjectNamespace;
  const bucket = {
    get: async (key: string) => ({
      json: async () => key.endsWith("commit-patches.json")
        ? commitPatchManifest(publication)
        : manifest,
    }),
    head: async () => ({ httpEtag: '"present"', size: 1 }),
  } as unknown as R2Bucket;
  const request = new Request("https://nanocodex.example/api/git/publish", {
    method: "PUT",
    headers: {
      authorization: "Bearer mirror-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedHead: null, publication, replaceInvalid: true }),
  });

  const response = await handleGitRequest(
    request,
    {
      GIT_OBJECTS: bucket,
      GIT_REPOSITORY: namespace,
      GIT_MIRROR_TOKEN: "mirror-token",
    },
    new URL(request.url),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(forwarded, {
    expectedHead: null,
    publication,
    replaceInvalid: true,
  });
});

test("repository publication gates commit indexes and every metadata page before cutover", async () => {
  const shardKey = `generations/${head}/objects/0000.pack`;
  const generationPrefix = `generations/${head}`;
  const publication = {
    version: 1 as const,
    head,
    branch: "master",
    refs: [{ name: "refs/heads/master", oid: head }],
    snapshotKey: `${generationPrefix}/repository.json`,
    commitsKey: `${generationPrefix}/commits.json`,
    commitPatchParts: [0, 1].map((page) => ({
      key: `${generationPrefix}/commit-patches/${String(page).padStart(4, "0")}.diff`,
      size: 1,
    })),
    commitPatchSize: 2,
    inventoryKey: `${generationPrefix}/inventory.json`,
    packParts: [{ key: `${generationPrefix}/packs/${packHash}/0000.pack`, size: 1 }],
    packSize: 1,
    objectManifestKey: `${generationPrefix}/objects.json`,
    packHash,
    publishedAt: "2026-08-18T00:00:00.000Z",
  };
  const objectManifest = {
    version: 1,
    head,
    shards: [{ key: shardKey, size: 1 }],
    objects: { [head]: [1, 0, 0, 1, []] },
  };
  const missingKeys = [
    `${generationPrefix}/commit-index.json`,
    `${generationPrefix}/commits/0001.json`,
  ];

  for (const missingKey of missingKeys) {
    let forwarded = false;
    const namespace = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: async () => {
          forwarded = true;
          return Response.json(publication);
        },
      }),
    } as unknown as DurableObjectNamespace;
    const bucket = {
      get: async (key: string) => ({
        json: async () => key.endsWith("commit-patches.json")
          ? commitPatchManifest(publication)
          : objectManifest,
      }),
      head: async (key: string) =>
        key === missingKey ? null : { httpEtag: '"present"', size: 1 },
    } as unknown as R2Bucket;
    const request = new Request("https://nanocodex.example/api/git/publish", {
      method: "PUT",
      headers: {
        authorization: "Bearer mirror-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedHead: null, publication }),
    });

    const response = await handleGitRequest(
      request,
      {
        GIT_OBJECTS: bucket,
        GIT_REPOSITORY: namespace,
        GIT_MIRROR_TOKEN: "mirror-token",
      },
      new URL(request.url),
    );

    assert.equal(response?.status, 409, missingKey);
    assert.equal(forwarded, false, missingKey);
    assert.deepEqual(await response?.json(), {
      error: "publication_objects_missing",
      missing: [missingKey],
    });
  }
});

test("repository publication requires every commit patch page before cutover", async () => {
  const shardKey = `generations/${head}/objects/0000.pack`;
  const publication = {
    version: 1 as const,
    head,
    branch: "master",
    refs: [{ name: "refs/heads/master", oid: head }],
    snapshotKey: `generations/${head}/repository.json`,
    commitsKey: `generations/${head}/commits.json`,
    commitPatchParts: [{
      key: `generations/${head}/commit-patches/0000.diff`,
      size: 1,
    }],
    commitPatchSize: 1,
    inventoryKey: `generations/${head}/inventory.json`,
    packParts: [{ key: `generations/${head}/packs/${packHash}/0000.pack`, size: 1 }],
    packSize: 1,
    objectManifestKey: `generations/${head}/objects.json`,
    packHash,
    publishedAt: "2026-08-18T00:00:00.000Z",
  };
  const manifest = {
    version: 1,
    head,
    shards: [{ key: shardKey, size: 1 }],
    objects: { [head]: [1, 0, 0, 1, []] },
  };
  let forwarded = false;
  const namespace = {
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({
      fetch: async () => {
        forwarded = true;
        return Response.json(publication);
      },
    }),
  } as unknown as DurableObjectNamespace;
  const bucket = {
    get: async (key: string) => ({
      json: async () => key.endsWith("commit-patches.json")
        ? commitPatchManifest(publication)
        : manifest,
    }),
    head: async (key: string) =>
      key === publication.commitPatchParts[0].key
        ? null
        : { httpEtag: '"present"', size: 1 },
  } as unknown as R2Bucket;
  const request = new Request("https://nanocodex.example/api/git/publish", {
    method: "PUT",
    headers: {
      authorization: "Bearer mirror-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedHead: null, publication }),
  });

  const response = await handleGitRequest(
    request,
    {
      GIT_OBJECTS: bucket,
      GIT_REPOSITORY: namespace,
      GIT_MIRROR_TOKEN: "mirror-token",
    },
    new URL(request.url),
  );

  assert.equal(response?.status, 409);
  assert.equal(forwarded, false);
  assert.deepEqual(await response?.json(), {
    error: "publication_objects_missing",
    missing: [publication.commitPatchParts[0].key],
  });

  const wrongSizeBucket = {
    get: async (key: string) => ({
      json: async () => key.endsWith("commit-patches.json")
        ? commitPatchManifest(publication)
        : manifest,
    }),
    head: async (key: string) => ({
      httpEtag: '"present"',
      size: key === publication.commitPatchParts[0].key ? 2 : 1,
    }),
  } as unknown as R2Bucket;
  const wrongSizeRequest = new Request("https://nanocodex.example/api/git/publish", {
    method: "PUT",
    headers: {
      authorization: "Bearer mirror-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedHead: null, publication }),
  });
  const wrongSizeResponse = await handleGitRequest(
    wrongSizeRequest,
    {
      GIT_OBJECTS: wrongSizeBucket,
      GIT_REPOSITORY: namespace,
      GIT_MIRROR_TOKEN: "mirror-token",
    },
    new URL(wrongSizeRequest.url),
  );
  assert.equal(wrongSizeResponse?.status, 409);
  assert.equal(forwarded, false);
  assert.deepEqual(await wrongSizeResponse?.json(), {
    error: "publication_commit_patch_parts_invalid",
    invalid: [publication.commitPatchParts[0].key],
  });
});

test("repository publication rejects pack parts whose stored size changed", async () => {
  const partKey = `generations/${head}/packs/${packHash}/0000.pack`;
  const publication = {
    version: 1 as const,
    head,
    branch: "master",
    refs: [{ name: "refs/heads/master", oid: head }],
    snapshotKey: `generations/${head}/repository.json`,
    commitsKey: `generations/${head}/commits.json`,
    commitPatchParts: [{
      key: `generations/${head}/commit-patches/0000.diff`,
      size: 1,
    }],
    commitPatchSize: 1,
    inventoryKey: `generations/${head}/inventory.json`,
    packParts: [{ key: partKey, size: 2 }],
    packSize: 2,
    objectManifestKey: `generations/${head}/objects.json`,
    packHash,
    publishedAt: "2026-08-18T00:00:00.000Z",
  };
  let forwarded = false;
  const namespace = {
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({
      fetch: async () => {
        forwarded = true;
        return Response.json(publication);
      },
    }),
  } as unknown as DurableObjectNamespace;
  const bucket = {
    get: async () => ({ json: async () => commitPatchManifest(publication) }),
    head: async () => ({
      httpEtag: '"present"',
      size: 1,
    }),
  } as unknown as R2Bucket;
  const request = new Request("https://nanocodex.example/api/git/publish", {
    method: "PUT",
    headers: {
      authorization: "Bearer mirror-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedHead: null, publication, replaceInvalid: true }),
  });

  const response = await handleGitRequest(
    request,
    {
      GIT_OBJECTS: bucket,
      GIT_REPOSITORY: namespace,
      GIT_MIRROR_TOKEN: "mirror-token",
    },
    new URL(request.url),
  );

  assert.equal(response?.status, 409);
  assert.equal(forwarded, false);
  assert.deepEqual(await response?.json(), {
    error: "publication_pack_parts_invalid",
    invalid: [partKey],
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

test("public Git requests are bounded after decompression", async () => {
  const request = new Request("https://nanocodex.example/git/git-upload-pack", {
    method: "POST",
    headers: { "content-encoding": "gzip" },
    body: gzipSync(new Uint8Array([1, 2, 3, 4, 5])),
  });

  const result = await readGitProtocolRequest(request, 4);
  assert.ok(result instanceof Response);
  assert.equal(result.status, 413);
  assert.equal(await result.text(), "Git request is too large\n");
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
    commitPatchParts: [{
      key: `generations/${head}/commit-patches/0000.diff`,
      size: 1,
    }],
    commitPatchSize: 1,
    inventoryKey: `generations/${head}/inventory.json`,
    packParts: [{ key: `generations/${head}/packs/${packHash}/0000.pack`, size: 1 }],
    packSize: 1,
    objectManifestKey: `generations/${head}/objects.json`,
    packHash,
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
