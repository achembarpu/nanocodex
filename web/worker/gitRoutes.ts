import {
  buildFullPackResponse,
  buildLsRefsResponse,
  buildNegotiationResponse,
  parseFetchArguments,
  parseV2Command,
  repositoryAdvertisement,
} from "./gitProtocol.ts";
import {
  isGitObjectManifest,
  selectGitObjects,
  type GitObjectManifest,
} from "./gitObjectManifest.ts";
import { createSelectedPackStream } from "./gitObjectPack.ts";
import {
  isRepositoryPublication,
  type RepositoryPublication,
} from "./gitRepository.ts";

const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const generationFilePattern = /^(repository\.json|commits\.json|inventory\.json|repository\.pack|objects\.json)$/;
const generationCommitPagePattern = /^commits\/(\d{4})\.json$/;
const generationObjectShardPattern = /^objects\/(\d{4})\.pack$/;
const immutableCacheControl = "public, max-age=31536000, immutable";

export type GitStorageEnv = {
  GIT_OBJECTS?: R2Bucket;
  GIT_REPOSITORY?: DurableObjectNamespace;
  GIT_MIRROR_TOKEN?: string;
};

export async function handleGitRequest(
  request: Request,
  env: GitStorageEnv,
  url: URL,
  context?: ExecutionContext,
): Promise<Response | undefined> {
  if (request.method === "GET" && url.pathname === "/api/repository/snapshot") {
    return servePublishedObject(request, env, context, "snapshotKey", false);
  }
  if (request.method === "GET" && url.pathname === "/api/repository/commits") {
    const page = url.searchParams.get("page");
    if (page != null) {
      if (!/^\d+$/.test(page) || Number(page) > 9_999) {
        return Response.json({ error: "invalid_commit_page" }, { status: 400 });
      }
      const generation = url.searchParams.get("generation");
      if (generation != null && !SHA1_PATTERN.test(generation)) {
        return Response.json({ error: "invalid_repository_generation" }, { status: 400 });
      }
      return generation == null
        ? servePublishedCommitPage(request, env, context, Number(page))
        : serveCommitPage(request, env, context, generation, Number(page));
    }
    return servePublishedObject(request, env, context, "commitsKey", false);
  }
  const blobMatch = url.pathname.match(/^\/api\/repository\/blob\/([a-f0-9]{40})$/);
  if (request.method === "GET" && blobMatch) {
    return serveObject(request, env, context, `blobs/${blobMatch[1]}.txt`, true);
  }
  const patchMatch = url.pathname.match(
    /^\/api\/repository\/commit\/([a-f0-9]{40})\.patch$/,
  );
  if (request.method === "GET" && patchMatch) {
    return serveObject(request, env, context, `patches/${patchMatch[1]}.patch`, true);
  }

  if (url.pathname === "/api/git/state" && request.method === "GET") {
    if (!(await authorizeMirrorRequest(request, env))) return unauthorized();
    const publication = await getPublication(env);
    if (publication instanceof Response) return publication;
    const inventory = await requireBucket(env).get(publication.inventoryKey);
    if (inventory == null) return storageFailure("published inventory is missing");
    const objectManifest = await requireBucket(env).get(publication.objectManifestKey);
    if (objectManifest == null) return storageFailure("published object manifest is missing");
    const parsedManifest: unknown = await objectManifest.json();
    if (!isGitObjectManifest(parsedManifest) || parsedManifest.head !== publication.head) {
      return storageFailure("published object manifest is invalid");
    }
    return Response.json({
      publication,
      inventory: await inventory.json(),
      objectManifest: parsedManifest,
    }, { headers: { "cache-control": "no-store" } });
  }

  if (url.pathname.startsWith("/api/git/objects/") && request.method === "PUT") {
    if (!(await authorizeMirrorRequest(request, env))) return unauthorized();
    const key = objectKeyFromUploadPath(url.pathname);
    if (key == null) return Response.json({ error: "invalid_object_key" }, { status: 400 });
    if (request.body == null) return Response.json({ error: "missing_body" }, { status: 400 });
    const bucket = requireBucket(env);
    const uploaded = await bucket.put(key, request.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: contentTypeForKey(key),
        cacheControl: immutableCacheControl,
      },
      customMetadata: { uploadedBy: "nanocodex-repository-mirror" },
    });
    const object = uploaded ?? await bucket.head(key);
    if (object == null) return storageFailure("immutable object upload did not resolve");
    return Response.json({
      key,
      etag: object.httpEtag,
      size: object.size,
      stored: uploaded != null,
    });
  }

  if (url.pathname === "/api/git/publish" && request.method === "PUT") {
    if (!(await authorizeMirrorRequest(request, env))) return unauthorized();
    let body: { expectedHead?: unknown; publication?: unknown };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const expectedHead = body.expectedHead;
    if (
      !(expectedHead === null ||
        (typeof expectedHead === "string" && SHA1_PATTERN.test(expectedHead))) ||
      !isRepositoryPublication(body.publication)
    ) {
      return Response.json({ error: "invalid_publication" }, { status: 400 });
    }
    const publication = body.publication;
    const requiredKeys = [
      publication.snapshotKey,
      publication.commitsKey,
      publication.inventoryKey,
      publication.packKey,
    ];
    const objects = await Promise.all(requiredKeys.map((key) => requireBucket(env).head(key)));
    const missing = requiredKeys.filter((_, index) => objects[index] == null);
    if (missing.length > 0) {
      return Response.json({ error: "publication_objects_missing", missing }, { status: 409 });
    }
    const storedManifest = await requireBucket(env).get(publication.objectManifestKey);
    if (storedManifest == null) {
      return Response.json(
        { error: "publication_objects_missing", missing: [publication.objectManifestKey] },
        { status: 409 },
      );
    }
    const manifest: unknown = await storedManifest.json();
    if (!isGitObjectManifest(manifest) || manifest.head !== publication.head) {
      return Response.json({ error: "invalid_object_manifest" }, { status: 409 });
    }
    const shards = await Promise.all(
      manifest.shards.map((shard) => requireBucket(env).head(shard.key)),
    );
    const missingShards = manifest.shards
      .filter((_, index) => shards[index] == null)
      .map((shard) => shard.key);
    if (missingShards.length > 0) {
      return Response.json(
        { error: "publication_objects_missing", missing: missingShards },
        { status: 409 },
      );
    }
    return repositoryStub(env).fetch("https://repository.internal/publication", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedHead, publication }),
    });
  }

  if (url.pathname === "/git/info/refs" && request.method === "GET") {
    if (url.searchParams.get("service") !== "git-upload-pack") {
      return new Response("unsupported service\n", { status: 400 });
    }
    return new Response(byteBody(repositoryAdvertisement()), {
      headers: {
        "cache-control": "no-cache",
        "content-type": "application/x-git-upload-pack-advertisement",
      },
    });
  }

  if (url.pathname === "/git/git-upload-pack" && request.method === "POST") {
    const publication = await getPublication(env);
    if (publication instanceof Response) return publication;
    let command: ReturnType<typeof parseV2Command>;
    try {
      const body = await readGitProtocolRequest(request);
      if (body instanceof Response) return body;
      command = parseV2Command(body);
    } catch {
      return new Response("malformed git protocol request\n", { status: 400 });
    }
    if (command.command === "ls-refs") {
      return gitUploadResponse(byteBody(buildLsRefsResponse(publication, command.arguments)));
    }
    if (command.command !== "fetch") {
      return new Response("unsupported git protocol command\n", { status: 400 });
    }
    let fetchRequest: ReturnType<typeof parseFetchArguments>;
    try {
      fetchRequest = parseFetchArguments(command.arguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid fetch arguments";
      return new Response(`${message}\n`, { status: 400 });
    }
    const manifest = await getObjectManifest(env, publication);
    if (manifest instanceof Response) return manifest;
    if (
      fetchRequest.wants.length === 0 ||
      fetchRequest.wants.some((oid) => manifest.objects[oid] == null)
    ) {
      return new Response("invalid fetch wants\n", { status: 400 });
    }
    const commonHaves = [...new Set(
      fetchRequest.haves.filter((oid) => manifest.objects[oid] != null),
    )];
    if (!fetchRequest.done) {
      return gitUploadResponse(byteBody(buildNegotiationResponse(commonHaves)));
    }
    if (
      fetchRequest.haves.length === 0 &&
      fetchRequest.shallow.length === 0 &&
      fetchRequest.deepen === 0
    ) {
      const pack = await requireBucket(env).get(publication.packKey);
      if (pack == null) return storageFailure("published pack is missing");
      return gitUploadResponse(buildFullPackResponse(pack.body));
    }
    const selection = selectGitObjects(
      manifest,
      fetchRequest.wants,
      fetchRequest.haves,
      fetchRequest.shallow,
      fetchRequest.deepen,
      fetchRequest.deepenRelative,
    );
    return gitUploadResponse(buildFullPackResponse(
      createSelectedPackStream(requireBucket(env), manifest, selection.objectIds),
      selection.shallow,
      selection.unshallow,
    ));
  }

  return undefined;
}

export async function readGitProtocolRequest(request: Request): Promise<Uint8Array | Response> {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity" && encoding !== "gzip") {
    return new Response("unsupported upload-pack content encoding\n", { status: 415 });
  }
  if (request.body == null) return new Uint8Array();
  const body = encoding === "gzip"
    ? request.body.pipeThrough(new DecompressionStream("gzip"))
    : request.body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function gitUploadResponse(body: BodyInit): Response {
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "application/x-git-upload-pack-result",
    },
  });
}

async function servePublishedObject(
  request: Request,
  env: GitStorageEnv,
  context: ExecutionContext | undefined,
  field: "snapshotKey" | "commitsKey",
  immutable: boolean,
): Promise<Response> {
  const cached = await matchEdgeCache(request);
  if (cached != null) return cached;
  const publication = await getPublication(env);
  if (publication instanceof Response) return publication;
  return serveObject(
    request,
    env,
    context,
    publication[field],
    immutable,
    publication.head,
    false,
  );
}

async function servePublishedCommitPage(
  request: Request,
  env: GitStorageEnv,
  context: ExecutionContext | undefined,
  page: number,
): Promise<Response> {
  const cached = await matchEdgeCache(request);
  if (cached != null) return cached;
  const publication = await getPublication(env);
  if (publication instanceof Response) return publication;
  return serveObject(
    request,
    env,
    context,
    `generations/${publication.head}/commits/${String(page).padStart(4, "0")}.json`,
    false,
    publication.head,
    false,
  );
}

function serveCommitPage(
  request: Request,
  env: GitStorageEnv,
  context: ExecutionContext | undefined,
  generation: string,
  page: number,
): Promise<Response> {
  return serveObject(
    request,
    env,
    context,
    `generations/${generation}/commits/${String(page).padStart(4, "0")}.json`,
    true,
    generation,
  );
}

async function serveObject(
  request: Request,
  env: GitStorageEnv,
  context: ExecutionContext | undefined,
  key: string,
  immutable: boolean,
  generation?: string,
  checkCache = true,
): Promise<Response> {
  const edgeCache = typeof caches === "undefined"
    ? undefined
    : (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(request.url, { method: "GET" });
  if (checkCache) {
    const cached = await edgeCache?.match(cacheKey);
    if (cached != null) return cached;
  }
  const object = await requireBucket(env).get(key);
  if (object == null) return Response.json({ error: "repository_object_not_found" }, { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", contentTypeForKey(key));
  headers.set(
    "cache-control",
    immutable ? immutableCacheControl : "public, max-age=60, stale-while-revalidate=300",
  );
  headers.set("etag", object.httpEtag);
  if (generation) headers.set("x-repository-generation", generation);
  headers.set("x-content-type-options", "nosniff");
  const response = new Response(object.body, { headers });
  if (edgeCache != null && context != null) {
    context.waitUntil(edgeCache.put(cacheKey, response.clone()));
  }
  return response;
}

async function matchEdgeCache(request: Request): Promise<Response | undefined> {
  const edgeCache = typeof caches === "undefined"
    ? undefined
    : (caches as CacheStorage & { default: Cache }).default;
  return edgeCache?.match(new Request(request.url, { method: "GET" }));
}

async function getPublication(env: GitStorageEnv): Promise<RepositoryPublication | Response> {
  if (!env.GIT_REPOSITORY || !env.GIT_OBJECTS) {
    return storageFailure("repository storage is not configured");
  }
  const response = await repositoryStub(env).fetch("https://repository.internal/publication");
  if (response.status === 404) {
    return Response.json({ error: "repository_not_published" }, { status: 503 });
  }
  if (!response.ok) return storageFailure("repository publication lookup failed");
  const publication: unknown = await response.json();
  return isRepositoryPublication(publication)
    ? publication
    : storageFailure("repository publication is invalid");
}

const objectManifestMemo = new WeakMap<object, Map<string, GitObjectManifest>>();

async function getObjectManifest(
  env: GitStorageEnv,
  publication: RepositoryPublication,
): Promise<GitObjectManifest | Response> {
  const bucket = requireBucket(env);
  let manifests = objectManifestMemo.get(bucket as object);
  const cached = manifests?.get(publication.head);
  if (cached != null) return cached;
  const stored = await bucket.get(publication.objectManifestKey);
  if (stored == null) return storageFailure("published object manifest is missing");
  const value: unknown = await stored.json();
  if (!isGitObjectManifest(value) || value.head !== publication.head) {
    return storageFailure("published object manifest is invalid");
  }
  if (manifests == null) {
    manifests = new Map();
    objectManifestMemo.set(bucket as object, manifests);
  }
  manifests.set(publication.head, value);
  while (manifests.size > 2) manifests.delete(manifests.keys().next().value!);
  return value;
}

function repositoryStub(env: GitStorageEnv): DurableObjectStub {
  if (!env.GIT_REPOSITORY) throw new Error("GIT_REPOSITORY is not configured");
  return env.GIT_REPOSITORY.get(env.GIT_REPOSITORY.idFromName("nanocodex"));
}

function requireBucket(env: GitStorageEnv): R2Bucket {
  if (!env.GIT_OBJECTS) throw new Error("GIT_OBJECTS is not configured");
  return env.GIT_OBJECTS;
}

function objectKeyFromUploadPath(pathname: string): string | null {
  const relative = pathname.slice("/api/git/objects/".length);
  const blob = relative.match(/^blobs\/([a-f0-9]{40})$/);
  if (blob) return `blobs/${blob[1]}.txt`;
  const patch = relative.match(/^patches\/([a-f0-9]{40})$/);
  if (patch) return `patches/${patch[1]}.patch`;
  const generation = relative.match(/^generations\/([a-f0-9]{40})\/([^/]+)$/);
  if (generation && generationFilePattern.test(generation[2])) {
    return `generations/${generation[1]}/${generation[2]}`;
  }
  const commitPage = relative.match(
    /^generations\/([a-f0-9]{40})\/(commits\/\d{4}\.json)$/,
  );
  if (commitPage && generationCommitPagePattern.test(commitPage[2])) {
    return `generations/${commitPage[1]}/${commitPage[2]}`;
  }
  const objectShard = relative.match(
    /^generations\/([a-f0-9]{40})\/(objects\/\d{4}\.pack)$/,
  );
  if (objectShard && generationObjectShardPattern.test(objectShard[2])) {
    return `generations/${objectShard[1]}/${objectShard[2]}`;
  }
  return null;
}

function contentTypeForKey(key: string): string {
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".pack") || key.endsWith(".idx")) return "application/octet-stream";
  return "text/plain; charset=utf-8";
}

async function authorizeMirrorRequest(request: Request, env: GitStorageEnv): Promise<boolean> {
  const expected = env.GIT_MIRROR_TOKEN ?? "";
  const presented = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!expected || !presented) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index++) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
  );
}

function storageFailure(message: string): Response {
  return Response.json(
    { error: message },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

function byteBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
