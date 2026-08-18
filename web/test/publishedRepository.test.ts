import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadPublishedRepositorySnapshot } from "../src/publishedRepository.ts";

const head = "a".repeat(40);
const commit = {
  hash: head,
  shortHash: head.slice(0, 7),
  parents: [],
  author: "Nanocodex",
  authoredAt: "2026-08-18T00:00:00.000Z",
  refs: ["HEAD -> master"],
  subject: "feat: publish repository",
  body: "",
  files: [],
  stats: { files: 0, additions: 0, deletions: 0 },
};
const document = {
  repository: {
    fullName: "gakonst/nanocodex",
    branch: "master",
    head,
    totalCommits: 1,
    indexedCommits: 1,
    commitPageSize: 32,
    dirty: false,
    dirtyCount: 0,
  },
  generatedAt: "2026-08-18T00:00:00.000Z",
  tree: [{
    path: "README.md",
    mode: "100644",
    objectId: "b".repeat(40),
    size: 12,
    contentUrl: `/api/repository/blob/${"b".repeat(40)}`,
  }],
};

test("published repository surfaces load the public snapshot and commit index", async () => {
  const requests: string[] = [];
  const request = async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url === "/api/repository/snapshot") {
      return Response.json(document, {
        headers: { "x-repository-generation": head },
      });
    }
    if (url === "/api/repository/commits") {
      return Response.json([commit], {
        headers: { "x-repository-generation": head },
      });
    }
    if (url === document.tree[0].contentUrl) return new Response("# Nanocodex\n");
    return new Response(null, { status: 404 });
  };

  const snapshot = await loadPublishedRepositorySnapshot(
    true,
    request as typeof fetch,
    false,
  );

  assert.deepEqual(requests, [
    "/api/repository/snapshot",
    "/api/repository/commits",
  ]);
  assert.equal(snapshot.repository.fullName, "gakonst/nanocodex");
  assert.deepEqual(snapshot.commits, [commit]);
  assert.equal(snapshot.commitPatchUrl(commit), `/api/repository/commit/${head}.patch`);
  assert.equal(await snapshot.readFile(snapshot.tree[0]), "# Nanocodex\n");
});

test("the Code surface does not fetch commit history", async () => {
  const requests: string[] = [];
  const request = async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json(document);
  };

  const snapshot = await loadPublishedRepositorySnapshot(
    false,
    request as typeof fetch,
    false,
  );

  assert.deepEqual(requests, ["/api/repository/snapshot"]);
  assert.equal(snapshot.historyLoaded, false);
  assert.deepEqual(snapshot.commits, []);
});

test("mixed publication generations fail instead of combining repository data", async () => {
  const request = async (input: string | URL | Request) => {
    if (String(input).endsWith("/snapshot")) {
      return Response.json(document, {
        headers: { "x-repository-generation": head },
      });
    }
    return Response.json([commit], {
      headers: { "x-repository-generation": "c".repeat(40) },
    });
  };

  await assert.rejects(
    loadPublishedRepositorySnapshot(true, request as typeof fetch, false),
    /publication changed while loading/,
  );
});

test("top-level Code and Commits are wired independently from thread Git", async () => {
  const app = await readFile(
    new URL("../src/NanocodexApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /loadPublishedRepositorySnapshot\(includeHistory\)/);
  assert.doesNotMatch(app, /loadThreadRepositorySnapshot/);
  assert.doesNotMatch(app, /subscribeThreadGitChanges/);
});
