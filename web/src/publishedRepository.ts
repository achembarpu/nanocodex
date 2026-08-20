import type {
  HarnessCommit,
  RepositoryFile,
} from "./threadRepositorySnapshot";

type PublishedRepositoryFile = RepositoryFile & {
  contentUrl: string | null;
};

type PublishedRepositoryDocument = {
  repository: {
    fullName: string;
    branch: string;
    head: string;
    totalCommits: number;
    indexedCommits?: number;
    commitPageSize?: number;
    dirty: boolean;
    dirtyCount: number;
  };
  generatedAt: string;
  tree: PublishedRepositoryFile[];
};

export type PublishedRepositorySnapshot = PublishedRepositoryDocument & {
  historyLoaded: boolean;
  commits: HarnessCommit[];
  readFile(file: RepositoryFile): Promise<string>;
  commitPatchUrl(commit: HarnessCommit): string;
};

type Fetch = typeof fetch;

export async function loadPublishedRepositorySnapshot(
  includeHistory = true,
  request: Fetch = fetch,
  development = import.meta.env?.DEV ?? false,
): Promise<PublishedRepositorySnapshot> {
  const base = development
    ? "/__nanocodex/repository"
    : "/api/repository";
  const snapshotResponse = await request(`${base}/snapshot`, {
    cache: "no-store",
  });
  if (!snapshotResponse.ok) {
    throw new Error(`Repository request failed (${snapshotResponse.status})`);
  }
  const snapshot = await snapshotResponse.json() as PublishedRepositoryDocument;
  requireRepositoryDocument(snapshot);
  requireGeneration(snapshotResponse, snapshot.repository.head);

  let commits: HarnessCommit[] = [];
  if (includeHistory) {
    const commitsResponse = await request(`${base}/commits`, {
      cache: "no-store",
    });
    if (!commitsResponse.ok) {
      throw new Error(`Commit request failed (${commitsResponse.status})`);
    }
    requireGeneration(commitsResponse, snapshot.repository.head);
    const body: unknown = await commitsResponse.json();
    if (!Array.isArray(body)) throw new Error("Repository commits are invalid");
    commits = body as HarnessCommit[];
  }

  const fileContents = new Map<string, Promise<string>>();

  return {
    ...snapshot,
    historyLoaded: includeHistory,
    commits,
    async readFile(file) {
      const cached = fileContents.get(file.objectId);
      if (cached) return cached;
      const published = snapshot.tree.find((candidate) =>
        candidate.objectId === file.objectId && candidate.path === file.path
      );
      if (published?.contentUrl == null) {
        throw new Error(`${file.path} is not available as published text`);
      }
      const pending = request(published.contentUrl, {
        cache: development ? "no-store" : "default",
      }).then((response) => {
        if (!response.ok) {
          throw new Error(`File request failed (${response.status})`);
        }
        return response.text();
      }).catch((error) => {
        if (fileContents.get(file.objectId) === pending) {
          fileContents.delete(file.objectId);
        }
        throw error;
      });
      fileContents.set(file.objectId, pending);
      return pending;
    },
    commitPatchUrl(commit) {
      return development
        ? `${base}/commits.diff?hash=${commit.hash}`
        : `${base}/commit/${commit.hash}.patch`;
    },
  };
}

function requireRepositoryDocument(
  value: PublishedRepositoryDocument,
): void {
  if (
    value == null ||
    typeof value !== "object" ||
    value.repository == null ||
    typeof value.repository.head !== "string" ||
    typeof value.repository.branch !== "string" ||
    !Array.isArray(value.tree)
  ) {
    throw new Error("Repository snapshot is invalid");
  }
}

function requireGeneration(response: Response, expected: string): void {
  const generation = response.headers.get("x-repository-generation");
  if (generation != null && generation !== expected) {
    throw new Error("Repository publication changed while loading");
  }
}
