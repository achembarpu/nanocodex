const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const REF_PATTERN = /^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const receiveLeaseTtlMs = 2 * 60 * 1_000;

export type RepositoryRef = {
  name: string;
  oid: string;
};

export type RepositoryView = {
  head: string;
  branch: string;
  refs: RepositoryRef[];
  packKey: string;
};

export type ThreadRepository = RepositoryView & {
  version: 1;
  packHash: string;
  packSize: number;
  updatedAt: string;
};

type ReceiveLease = { token: string; expiresAt: number };

const threadStorageKey = "thread";
const receiveLeaseStorageKey = "receive-lease";

export class ThreadGitRepository {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/thread" && request.method === "GET") {
      const repository = await this.#state.storage.get<ThreadRepository>(threadStorageKey);
      return repository
        ? Response.json(repository)
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.pathname === "/receive/begin" && request.method === "POST") {
      return this.#beginReceive();
    }
    if (url.pathname === "/receive/finalize" && request.method === "PUT") {
      return this.#finalizeReceive(request);
    }
    if (url.pathname === "/receive/abort" && request.method === "POST") {
      return this.#abortReceive(request);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async #beginReceive(): Promise<Response> {
    return this.#state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const current = await this.#state.storage.get<ReceiveLease>(receiveLeaseStorageKey);
      if (current && current.expiresAt > now) {
        return Response.json({ error: "receive_busy" }, { status: 409 });
      }
      const lease = {
        token: crypto.randomUUID(),
        expiresAt: now + receiveLeaseTtlMs,
      };
      await this.#state.storage.put(receiveLeaseStorageKey, lease);
      return Response.json({ lease });
    });
  }

  async #finalizeReceive(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as {
      token?: unknown;
      repository?: unknown;
    } | undefined;
    if (typeof body?.token !== "string" || !isThreadRepository(body.repository)) {
      return Response.json({ error: "invalid_receive" }, { status: 400 });
    }
    return this.#state.blockConcurrencyWhile(async () => {
      const lease = await this.#state.storage.get<ReceiveLease>(receiveLeaseStorageKey);
      if (!lease || lease.token !== body.token || lease.expiresAt <= Date.now()) {
        return Response.json({ error: "receive_lease_expired" }, { status: 409 });
      }
      const previous = await this.#state.storage.get<ThreadRepository>(threadStorageKey);
      await this.#state.storage.put(threadStorageKey, body.repository);
      await this.#state.storage.delete(receiveLeaseStorageKey);
      return Response.json({ repository: body.repository, previousPackKey: previous?.packKey });
    });
  }

  async #abortReceive(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as { token?: unknown } | undefined;
    if (typeof body?.token !== "string") {
      return Response.json({ error: "invalid_receive" }, { status: 400 });
    }
    return this.#state.blockConcurrencyWhile(async () => {
      const lease = await this.#state.storage.get<ReceiveLease>(receiveLeaseStorageKey);
      if (lease?.token === body.token) {
        await this.#state.storage.delete(receiveLeaseStorageKey);
      }
      return Response.json({ ok: true });
    });
  }
}

export function isThreadRepository(value: unknown): value is ThreadRepository {
  if (!isRepositoryView(value)) return false;
  const repository = value as Partial<ThreadRepository>;
  return repository.version === 1 &&
    repository.branch === "nanocodex" &&
    typeof repository.packHash === "string" && SHA1_PATTERN.test(repository.packHash) &&
    typeof repository.packSize === "number" && Number.isSafeInteger(repository.packSize) &&
    repository.packSize > 0 &&
    typeof repository.updatedAt === "string" && Number.isFinite(Date.parse(repository.updatedAt)) &&
    typeof repository.packKey === "string" &&
    /^thread-repositories\/[A-Za-z0-9._-]+\/[A-Za-z0-9-]+\.pack$/.test(repository.packKey);
}

function isRepositoryView(value: unknown): value is RepositoryView {
  if (value == null || typeof value !== "object") return false;
  const repository = value as Partial<RepositoryView>;
  return typeof repository.head === "string" && SHA1_PATTERN.test(repository.head) &&
    typeof repository.branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(repository.branch) &&
    typeof repository.packKey === "string" && repository.packKey.length > 0 &&
    Array.isArray(repository.refs) && repository.refs.every((ref) =>
      ref != null && typeof ref === "object" &&
      typeof ref.name === "string" && REF_PATTERN.test(ref.name) &&
      typeof ref.oid === "string" && SHA1_PATTERN.test(ref.oid)
    );
}
