const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const REF_PATTERN = /^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

export type RepositoryRef = {
  name: string;
  oid: string;
  peeled?: string;
};

export type RepositoryPublication = {
  version: 1;
  head: string;
  branch: string;
  refs: RepositoryRef[];
  snapshotKey: string;
  commitsKey: string;
  inventoryKey: string;
  packKey: string;
  objectManifestKey: string;
  packHash: string;
  publishedAt: string;
};

type PublishRequest = {
  expectedHead: string | null;
  publication: RepositoryPublication;
};

const publicationStorageKey = "publication";

export class GitRepository {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/publication") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.method === "GET") {
      const publication = await this.#state.storage.get<RepositoryPublication>(
        publicationStorageKey,
      );
      return publication == null
        ? Response.json({ error: "not_published" }, { status: 404 })
        : Response.json(publication);
    }
    if (request.method !== "PUT") {
      return new Response(null, { status: 405 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!isPublishRequest(body)) {
      return Response.json({ error: "invalid_publication" }, { status: 400 });
    }

    return this.#state.blockConcurrencyWhile(async () => {
      const current = await this.#state.storage.get<RepositoryPublication>(
        publicationStorageKey,
      );
      if ((current?.head ?? null) !== body.expectedHead) {
        return Response.json(
          { error: "publication_conflict", currentHead: current?.head ?? null },
          { status: 409 },
        );
      }
      await this.#state.storage.put(publicationStorageKey, body.publication);
      return Response.json(body.publication);
    });
  }
}

export function isRepositoryPublication(
  value: unknown,
): value is RepositoryPublication {
  if (value == null || typeof value !== "object") return false;
  const publication = value as Partial<RepositoryPublication>;
  if (
    publication.version !== 1 ||
    typeof publication.head !== "string" ||
    !SHA1_PATTERN.test(publication.head) ||
    typeof publication.branch !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(publication.branch) ||
    !Array.isArray(publication.refs) ||
    typeof publication.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(publication.publishedAt)) ||
    typeof publication.packHash !== "string" ||
    !SHA1_PATTERN.test(publication.packHash)
  ) {
    return false;
  }
  if (
    !publication.refs.every(
      (ref) =>
        ref != null &&
        typeof ref === "object" &&
        typeof ref.name === "string" &&
        REF_PATTERN.test(ref.name) &&
        typeof ref.oid === "string" &&
        SHA1_PATTERN.test(ref.oid) &&
        (ref.peeled === undefined ||
          (typeof ref.peeled === "string" && SHA1_PATTERN.test(ref.peeled))),
    )
  ) {
    return false;
  }
  const prefix = `generations/${publication.head}/`;
  return publication.snapshotKey === `${prefix}repository.json` &&
    publication.commitsKey === `${prefix}commits.json` &&
    publication.inventoryKey === `${prefix}inventory.json` &&
    publication.packKey === `${prefix}repository.pack` &&
    publication.objectManifestKey === `${prefix}objects.json`;
}

function isPublishRequest(value: unknown): value is PublishRequest {
  if (value == null || typeof value !== "object") return false;
  const request = value as Partial<PublishRequest>;
  return (
    (request.expectedHead === null ||
      (typeof request.expectedHead === "string" &&
        SHA1_PATTERN.test(request.expectedHead))) &&
    isRepositoryPublication(request.publication)
  );
}

export const gitObjectPatterns = {
  blob: SHA1_PATTERN,
  patch: SHA1_PATTERN,
  generation: SHA1_PATTERN,
} as const;
