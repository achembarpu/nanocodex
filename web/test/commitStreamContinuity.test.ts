import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loaderUrl = new URL("../src/useCommitStreamLoader.ts", import.meta.url);
const streamUrl = new URL("../src/CommitCodeStream.tsx", import.meta.url);
const commitsCssUrl = new URL("../src/Commits.css", import.meta.url);

test("stream batches retry pending commit jumps after publication", async () => {
  const [loader, stream] = await Promise.all([
    readFile(loaderUrl, "utf8"),
    readFile(streamUrl, "utf8"),
  ]);

  assert.match(loader, /onItemsPublished\?\.\(\)/);
  assert.equal(loader.match(/onItemsPublished\?\.\(\)/g)?.length, 2);
  assert.match(
    loader,
    /viewer\.addItems\(pendingItems\)[\s\S]*await yieldToBrowser\(\);[\s\S]*onItemsPublished\?\.\(\)/,
  );
  assert.match(
    stream,
    /onItemsPublished: tryApplyPendingJump/,
  );
  assert.match(
    stream,
    /tryApplyPendingCommitJump\([\s\S]*pendingJumpRef,[\s\S]*viewerRef\.current,[\s\S]*commits/,
  );
});

test("retry retains published items and renders a tail error", async () => {
  const [loader, stream] = await Promise.all([
    readFile(loaderUrl, "utf8"),
    readFile(streamUrl, "utf8"),
  ]);

  assert.doesNotMatch(loader, /setInitialItems\(\[\]\)/);
  assert.doesNotMatch(loader, /setViewerKey\(requestId\);\s*setInitialItems\(\[\]\)/);
  assert.match(
    stream,
    /initialItems\.length > 0 \|\| loadState === "ready"/,
  );
  assert.match(stream, /errorMode === "tail"/);
  assert.match(stream, /className="commit-stream-tail-error" role="alert"/);
  assert.match(stream, /onClick=\{retryLoad\}/);
});

test("production Commit streaming retains one aggregate request", async () => {
  const loader = await readFile(loaderUrl, "utf8");

  assert.match(loader, /if \(typeof patchUrl === "string"\) \{/);
  assert.match(
    loader,
    /const response = await fetch\(patchUrl, \{[\s\S]*cache: "default",[\s\S]*signal: controller\.signal/,
  );
  assert.doesNotMatch(
    loader.slice(
      loader.indexOf('if (typeof patchUrl === "string")'),
      loader.indexOf("} else {", loader.indexOf('if (typeof patchUrl === "string")')),
    ),
    /streamCommitPatches|patchUrl\(commit\)/,
  );
});

test("the virtual commit rail visually recedes without weakening focus", async () => {
  const styles = await readFile(commitsCssUrl, "utf8");

  assert.match(styles, /\.commits-workspace \.commit-sidebar[\s\S]*background:\s*transparent/);
  assert.match(styles, /\.commit-row\.is-selected[\s\S]*color-mix\([\s\S]*box-shadow:\s*inset 1px/);
  assert.match(styles, /\.commit-row:focus-visible[\s\S]*outline:\s*1px solid var\(--text-muted\)/);
  assert.doesNotMatch(styles, /box-shadow:\s*var\(--shadow-overlay\)/);
});
