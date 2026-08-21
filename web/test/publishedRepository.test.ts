import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  fetchPublishedRepositoryPatch,
  loadPublishedCommitHistory,
  loadPublishedRepositorySnapshot,
  preloadPublishedRepositoryPatch,
} from "../src/publishedRepository.ts";

const head = "a".repeat(40);
const hashes = [
  head,
  ...Array.from({ length: 64 }, (_, index) =>
    (index + 1).toString(16).padStart(40, "0")
  ),
];
const targetHash = hashes[32]!;
const repository = {
  fullName: "gakonst/nanocodex",
  branch: "master",
  head,
  totalCommits: hashes.length,
  indexedCommits: hashes.length,
  commitPageSize: 32,
  dirty: false,
  dirtyCount: 0,
};
const generatedAt = "2026-08-18T00:00:00.000Z";
const commits = hashes.map((hash, index) => ({
  hash,
  shortHash: hash.slice(0, 7),
  parents: index + 1 < hashes.length ? [hashes[index + 1]!] : [],
  author: "Nanocodex",
  authoredAt: generatedAt,
  refs: index === 0 ? ["HEAD -> master"] : [],
  subject: index === 1 ? "perf(web): page commits" : `chore: commit ${index}`,
  body: "",
  files: [],
  stats: { files: 0, additions: 0, deletions: 0 },
}));
const commitIndex = {
  version: 1,
  repository,
  generatedAt,
  hashes,
  scopeCounts: { all: hashes.length, eval: 0, fix: 0, docs: 0, perf: 1 },
};
const document = {
  repository,
  generatedAt,
  tree: [{
    path: "README.md",
    mode: "100644",
    objectId: "b".repeat(40),
    size: 12,
    contentUrl: `/api/repository/blob/${"b".repeat(40)}`,
  }],
};

test("the Source surface loads only the public snapshot", async () => {
  const requests: string[] = [];
  const cacheModes: Array<RequestCache | undefined> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    cacheModes.push(init?.cache);
    if (url === "/api/repository/snapshot") {
      return Response.json(document, {
        headers: { "x-repository-generation": head },
      });
    }
    if (url === document.tree[0]!.contentUrl) return new Response("# Nanocodex\n");
    return new Response(null, { status: 404 });
  };

  const snapshot = await loadPublishedRepositorySnapshot(
    request as typeof fetch,
    false,
  );

  assert.deepEqual(requests, ["/api/repository/snapshot"]);
  assert.deepEqual(cacheModes, ["default"]);
  assert.equal(snapshot.repository.fullName, "gakonst/nanocodex");
  assert.equal(await snapshot.readFile(snapshot.tree[0]!), "# Nanocodex\n");
  assert.equal(await snapshot.readFile(snapshot.tree[0]!), "# Nanocodex\n");
  assert.equal(requests.filter((url) => url === document.tree[0]!.contentUrl).length, 1);
});

test("an exact commit deep link loads only its generation-qualified metadata page", async () => {
  const requests: string[] = [];
  const cacheModes: Array<RequestCache | undefined> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    cacheModes.push(init?.cache);
    if (url === "/api/repository/commit-index") {
      return Response.json(commitIndex, {
        headers: { "x-repository-generation": head },
      });
    }
    if (url === `/api/repository/commits?generation=${head}&page=1`) {
      return Response.json(commits.slice(32, 64), {
        headers: { "x-repository-generation": head },
      });
    }
    return new Response(null, { status: 404 });
  };

  const history = await loadPublishedCommitHistory(
    targetHash,
    request as typeof fetch,
    false,
  );

  assert.deepEqual(requests, [
    "/api/repository/commit-index",
    `/api/repository/commits?generation=${head}&page=1`,
  ]);
  assert.deepEqual(cacheModes, ["default", "default"]);
  assert.equal(history.initialCommitHash, targetHash);
  assert.equal(history.initialPage.index, 1);
  assert.deepEqual(
    history.initialPage.commits.map(({ hash }) => hash),
    hashes.slice(32, 64),
  );
  assert.equal(
    history.initialPage.patchUrl,
    `/api/repository/commits/${head}/0001.diff`,
  );
  assert.equal(history.pageForCommit(hashes[64]!), 2);
  assert.equal(requests.some((url) => url === "/api/repository/commits"), false);
  assert.equal(requests.some((url) => url === `/api/repository/commits/${head}.diff`), false);
  assert.equal(requests.some((url) => url === "/api/repository/snapshot"), false);
});

test("development commit pages retain callable per-commit patches", async () => {
  const request = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/commit-index")) return Response.json(commitIndex);
    if (url.endsWith(`commits?generation=${head}&page=0`)) {
      return Response.json(commits.slice(0, 32));
    }
    return new Response(null, { status: 404 });
  };

  const history = await loadPublishedCommitHistory(
    undefined,
    request as typeof fetch,
    true,
  );

  assert.equal(typeof history.initialPage.patchUrl, "function");
  assert.equal(
    typeof history.initialPage.patchUrl === "function"
      ? history.initialPage.patchUrl(commits[0]!)
      : null,
    `/__nanocodex/repository/commits.diff?hash=${head}`,
  );
});

test("mixed publication generations fail instead of combining commit pages", async () => {
  const request = async (input: string | URL | Request) => {
    if (String(input).endsWith("/commit-index")) {
      return Response.json(commitIndex, {
        headers: { "x-repository-generation": head },
      });
    }
    return Response.json(commits.slice(0, 32), {
      headers: { "x-repository-generation": "c".repeat(40) },
    });
  };

  await assert.rejects(
    loadPublishedCommitHistory(undefined, request as typeof fetch, false),
    /publication changed while loading/,
  );
});

test("unknown exact commit links fail before a patch request", async () => {
  const requests: string[] = [];
  const request = async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json(commitIndex, {
      headers: { "x-repository-generation": head },
    });
  };

  await assert.rejects(
    loadPublishedCommitHistory("f".repeat(40), request as typeof fetch, false),
    /was not found/,
  );
  assert.deepEqual(requests, ["/api/repository/commit-index"]);
});

test("commit index and metadata JSON are bounded before parsing", async () => {
  const oversizedIndexRequest = async () => Response.json(commitIndex, {
    headers: {
      "content-length": String((512 * 1024) + 1),
      "x-repository-generation": head,
    },
  });
  await assert.rejects(
    loadPublishedCommitHistory(
      undefined,
      oversizedIndexRequest as typeof fetch,
      false,
    ),
    /Commit index exceeded its 524288-byte limit/,
  );

  const oversizedPageRequest = async (input: string | URL | Request) => {
    if (String(input).endsWith("/commit-index")) {
      return Response.json(commitIndex, {
        headers: { "x-repository-generation": head },
      });
    }
    return Response.json(commits.slice(0, 32), {
      headers: {
        "content-length": String((2 * 1024 * 1024) + 1),
        "x-repository-generation": head,
      },
    });
  };
  await assert.rejects(
    loadPublishedCommitHistory(
      undefined,
      oversizedPageRequest as typeof fetch,
      false,
    ),
    /Commit page 0 exceeded its 2097152-byte limit/,
  );
});

test("the current commit index format caps pages at 32 commits", async () => {
  const invalidIndex = {
    ...commitIndex,
    repository: { ...repository, commitPageSize: 33 },
  };
  const request = async () => Response.json(invalidIndex, {
    headers: { "x-repository-generation": head },
  });
  await assert.rejects(
    loadPublishedCommitHistory(undefined, request as typeof fetch, false),
    /Published repository metadata is invalid/,
  );
});

test("a route-intent patch prefetch is consumed without a duplicate request", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response("diff --git a/README.md b/README.md\n");
  }) as typeof fetch;

  try {
    const patchUrl = `/api/repository/commits/${head}/0001.diff`;
    await preloadPublishedRepositoryPatch(patchUrl);
    const response = await fetchPublishedRepositoryPatch(
      patchUrl,
      new AbortController().signal,
    );
    assert.equal(await response.text(), "diff --git a/README.md b/README.md\n");
    assert.deepEqual(requests, [patchUrl]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("top-level Source and Commits are wired independently from thread Git", async () => {
  const [app, entry] = await Promise.all([
    readFile(new URL("../src/NanocodexApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /loadPublishedRepositorySnapshot\(\)/);
  assert.match(app, /loadPublishedCommitHistory\(requestedCommit\)/);
  assert.doesNotMatch(app, /loadThreadRepositorySnapshot/);
  assert.doesNotMatch(app, /subscribeThreadGitChanges/);
  assert.match(
    entry,
    /preloadPublishedRepositorySnapshot\(\)[\s\S]*preloadPreferredPublishedFile/,
  );
  assert.match(
    entry,
    /loadPublishedCommitHistory\([\s\S]*?requestedHash[\s\S]*?preloadPublishedRepositoryPatch/,
  );
});
