import assert from "node:assert/strict";
import test from "node:test";

import { inspectStreamedCommitFileSections } from "../src/commitPatchSections.ts";
import { streamGitPatchFiles } from "../src/streamGitPatchFiles.ts";

test("an empty commit section is retained before the following commit's file", async () => {
  const emptyHash = "a".repeat(40);
  const fileHash = "b".repeat(40);
  const patch = [
    `From ${emptyHash} Mon Sep 17 00:00:00 2001`,
    "From: Nanocodex <test@nanocodex.invalid>",
    "Subject: [PATCH 1/2] empty merge",
    "",
    `From ${fileHash} Mon Sep 17 00:00:00 2001`,
    "From: Nanocodex <test@nanocodex.invalid>",
    "Subject: [PATCH 2/2] file change",
    "",
    "diff --git a/README.md b/README.md",
    "index 1111111..2222222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const streamedFiles: string[] = [];

  const fallback = await streamGitPatchFiles(
    new Response(patch).body!,
    async (fileText) => { streamedFiles.push(fileText); },
  );

  assert.equal(fallback, undefined);
  assert.equal(streamedFiles.length, 1);
  assert.deepEqual(inspectStreamedCommitFileSections(streamedFiles[0]!), {
    leadingHashes: [emptyHash, fileHash],
    fileCommitHash: fileHash,
    trailingHashes: [],
    nextCommitHash: fileHash,
  });
});

test("a trailing empty commit becomes the next active section", async () => {
  const fileHash = "c".repeat(40);
  const emptyHash = "d".repeat(40);
  const fileText = [
    `From ${fileHash} Mon Sep 17 00:00:00 2001`,
    "diff --git a/file b/file",
    "--- a/file",
    "+++ b/file",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    `From ${emptyHash} Mon Sep 17 00:00:00 2001`,
    "Subject: [PATCH 2/2] empty tail",
    "",
  ].join("\n");

  assert.deepEqual(inspectStreamedCommitFileSections(fileText), {
    leadingHashes: [fileHash],
    fileCommitHash: fileHash,
    trailingHashes: [emptyHash],
    nextCommitHash: emptyHash,
  });
});
