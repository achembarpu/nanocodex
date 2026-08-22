import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loaderUrl = new URL("../src/useCommitStreamLoader.ts", import.meta.url);
const streamUrl = new URL("../src/CommitCodeStream.tsx", import.meta.url);
const virtualCommitListUrl = new URL(
  "../src/VirtualCommitList.tsx",
  import.meta.url,
);
const commitsCssUrl = new URL("../src/Commits.css", import.meta.url);
const publishedRepositoryUrl = new URL(
  "../src/publishedRepository.ts",
  import.meta.url,
);
const pierreUrl = new URL("../src/pierreCodeView.ts", import.meta.url);

test("stream batches retry pending commit jumps after publication", async () => {
  const [loader, stream] = await Promise.all([
    readFile(loaderUrl, "utf8"),
    readFile(streamUrl, "utf8"),
  ]);

  assert.match(loader, /onItemsPublished\?\.\(\)/);
  assert.equal(loader.match(/onItemsPublished\?\.\(\)/g)?.length, 1);
  assert.match(
    loader,
    /viewer\.addItems\(preparedItems\)[\s\S]*await yieldToBrowser\(\);[\s\S]*publishItems\(\)/,
  );
  assert.match(
    stream,
    /onItemsPublished: tryApplyPendingJump/,
  );
  assert.match(
    stream,
    /tryApplyPendingCommitJump\([\s\S]*pendingJumpRef,[\s\S]*viewerRef\.current/,
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
  assert.match(stream, /errorMode === "tail" \|\| windowError/);
  assert.match(stream, /retryLoad\(\)/);
});

test("production Commit streaming retains one bounded page request at a time", async () => {
  const [loader, stream, publishedRepository] = await Promise.all([
    readFile(loaderUrl, "utf8"),
    readFile(streamUrl, "utf8"),
    readFile(publishedRepositoryUrl, "utf8"),
  ]);

  assert.match(loader, /if \(typeof page\.patchUrl === "string"\) \{/);
  assert.match(
    loader,
    /fetchPublishedRepositoryPatch\([\s\S]*page\.patchUrl,[\s\S]*controller\.signal/,
  );
  assert.match(loader, /MAX_PATCH_SHARD_BYTES = 16 \* 1024 \* 1024/);
  assert.match(loader, /nextPageRequested[\s\S]*history\.loadPage\(nextPageIndex\)/);
  assert.match(
    publishedRepository,
    /return fetch\(patchUrl, \{ cache: "default", signal \}\)/,
  );
  assert.doesNotMatch(
    loader.slice(
      loader.indexOf('if (typeof page.patchUrl === "string")'),
      loader.indexOf("} else {", loader.indexOf('if (typeof page.patchUrl === "string")')),
    ),
    /streamCommitPatches|patchUrl\(commit\)/,
  );
  assert.doesNotMatch(publishedRepository, /commits\/\$\{index\.repository\.head\}\.diff/);
  assert.match(
    stream,
    /windowRequestIdRef\.current !== requestId\) return;[\s\S]*preloadPublishedRepositoryPatch\(page\.patchUrl\)/,
  );
});

test("a deep-link metadata window fills toward page zero even without a scrollbar", async () => {
  const virtualCommitList = await readFile(virtualCommitListUrl, "utf8");

  assert.match(virtualCommitList, /window\.requestAnimationFrame/);
  assert.match(
    virtualCommitList,
    /list\.scrollHeight > list\.clientHeight \+ 240[\s\S]*onLoadMore\(\)/,
  );
});

test("the first Commit diff is isolated before background ingestion", async () => {
  const [loader, pierre] = await Promise.all([
    readFile(loaderUrl, "utf8"),
    readFile(pierreUrl, "utf8"),
  ]);

  assert.match(pierre, /COMMIT_INITIAL_BATCH_COUNT = 1/);
  assert.match(loader, /publishFileBatchSize = hasPublishedInitialItems[\s\S]*COMMIT_INITIAL_BATCH_COUNT/);
  assert.match(
    loader,
    /if \(isInitialPublish\) \{[\s\S]*await waitForViewer\(viewerRef, controller\.signal\)/,
  );
  assert.match(
    loader,
    /while \(!signal\.aborted && viewerRef\.current == null\)/,
  );
});

test("the virtual commit rail visually recedes without weakening focus", async () => {
  const styles = await readFile(commitsCssUrl, "utf8");

  assert.match(styles, /\.commits-workspace \.commit-sidebar[\s\S]*background:\s*transparent/);
  assert.match(styles, /\.commit-row\.is-selected[\s\S]*color-mix\([\s\S]*box-shadow:\s*inset 1px/);
  assert.match(styles, /\.commit-row:focus-visible[\s\S]*outline:\s*1px solid var\(--text-muted\)/);
  assert.doesNotMatch(styles, /box-shadow:\s*var\(--shadow-overlay\)/);
});
