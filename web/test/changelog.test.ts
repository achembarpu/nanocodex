import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  changelogEntry,
  loadNightlyChangelog,
  MAX_CHANGELOG_COMMITS,
  MAX_CHANGELOG_PAGES,
} from "../src/changelogData.ts";
import type { HarnessCommit } from "../src/threadRepositorySnapshot.ts";

const head = "a".repeat(40);

function commit(
  index: number,
  subject: string,
  authoredAt = "2026-08-21T08:00:00.000Z",
  body = "",
): HarnessCommit {
  const hash = index.toString(16).padStart(40, "0");
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    author: "Nanocodex",
    authoredAt,
    refs: [],
    subject,
    body,
    files: [],
    stats: { files: 0, additions: 0, deletions: 0 },
  };
}

test("loads one nightly from generation-pinned commit pages only", async () => {
  const newest = Array.from({ length: 32 }, (_, index) =>
    commit(index + 1, index === 0
      ? "feat(web): add nightly changelog"
      : "perf(web): reduce changelog transfer"));
  const tail = [
    commit(33, "fix(web): keep nightly dates stable"),
    commit(34, "docs: explain nightly revisions"),
    commit(35, "fix: older change", "2026-08-20T23:59:59.000Z"),
  ];
  const requests: Array<{ cache?: RequestCache; url: string }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ cache: init?.cache, url });
    if (url === "/api/repository/snapshot") {
      return Response.json({ repository: { head } });
    }
    if (url.endsWith(`page=0&generation=${head}`)) {
      return Response.json(newest, {
        headers: { "x-repository-generation": head },
      });
    }
    if (url.endsWith(`page=1&generation=${head}`)) {
      return Response.json(tail, {
        headers: { "x-repository-generation": head },
      });
    }
    return new Response(null, { status: 404 });
  };

  const nightly = await loadNightlyChangelog(request as typeof fetch, false);

  assert.equal(nightly.date, "2026-08-21");
  assert.equal(nightly.revision, head);
  assert.equal(nightly.entries.length, 34);
  assert.deepEqual(requests, [
    { cache: "default", url: "/api/repository/snapshot" },
    {
      cache: "force-cache",
      url: `/api/repository/commits?page=0&generation=${head}`,
    },
    {
      cache: "force-cache",
      url: `/api/repository/commits?page=1&generation=${head}`,
    },
  ]);
  assert.equal(
    requests.some(({ url }) =>
      url === "/api/repository/commits" || /\.(?:diff|patch)(?:\?|$)/.test(url)
    ),
    false,
  );
});

test("classifies conventional commits into the compact changelog grammar", () => {
  assert.deepEqual(
    changelogEntry(commit(1, "feat(web): add nightly changelog")),
    {
      category: "New Features",
      description: "Add nightly changelog.",
      hash: "1".padStart(40, "0"),
      title: "Nightly changelog",
    },
  );
  assert.equal(
    changelogEntry(commit(2, "perf(web): stream pages in bounded parts")).category,
    "Improvements",
  );
  assert.deepEqual(
    changelogEntry(commit(
      3,
      "fix(web): preserve complete nightly output",
      undefined,
      "Keep the previous page visible until the replacement is complete.",
    )),
    {
      category: "Bug Fixes",
      description: "Keep the previous page visible until the replacement is complete.",
      hash: "3".padStart(40, "0"),
      title: "Complete nightly output",
    },
  );
});

test("caps immutable page requests and retained nightly entries", async () => {
  let pageRequests = 0;
  const request = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/snapshot")) {
      return Response.json({ repository: { head } });
    }
    pageRequests += 1;
    return Response.json(
      Array.from({ length: 32 }, (_, index) =>
        commit(pageRequests * 100 + index, "chore: bounded record")),
      { headers: { "x-repository-generation": head } },
    );
  };

  const nightly = await loadNightlyChangelog(request as typeof fetch, false);

  assert.ok(pageRequests <= MAX_CHANGELOG_PAGES);
  assert.equal(nightly.entries.length, MAX_CHANGELOG_COMMITS);
});

test("rejects oversized commit pages before parsing them", async () => {
  const request = async (input: string | URL | Request) => {
    if (String(input).endsWith("/snapshot")) {
      return Response.json({ repository: { head } });
    }
    return new Response("[]", {
      headers: {
        "content-length": String(300 * 1024),
        "x-repository-generation": head,
      },
    });
  };

  await assert.rejects(
    loadNightlyChangelog(request as typeof fetch, false),
    /exceeds the data limit/,
  );
});

test("renders no loading copy and exposes an actionable failure state", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/Changelog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/Changelog.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(source, /loading|spinner|skeleton/i);
  assert.match(source, /<Suspense fallback=\{null\}>|use\(request\)/);
  assert.match(source, /Changelog unavailable\./);
  assert.match(source, />\s*Try again\s*</);
  assert.match(source, /New Features[\s\S]*Improvements[\s\S]*Bug Fixes/);
  assert.doesNotMatch(source, /<details|<summary|aria-expanded|entries\.slice|categoryFilter/);
  assert.doesNotMatch(source, /if \(entries\.length === 0\) return null/);
  assert.match(source, /className="changelog-empty">No entries\./);
  assert.match(source, /href=\{pathForCommit\(changelog\.revision\)\}/);
  assert.match(source, /onClick=\{\(event\) => onCommitClick\(event, changelog\.revision\)\}/);
  assert.match(source, /href=\{pathForCommit\(entry\.hash\)\}/);
  assert.match(source, /onClick=\{\(event\) => onCommitClick\(event, entry\.hash\)\}/);
  assert.doesNotMatch(source, /github\.com\/.*\/commit/);
  assert.doesNotMatch(styles, /line-clamp|text-overflow|max-height/);
  assert.match(styles, /\.changelog-categories p[\s\S]*overflow:\s*visible[\s\S]*white-space:\s*normal/);
});
