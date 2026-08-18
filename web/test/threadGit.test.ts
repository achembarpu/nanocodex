import assert from "node:assert/strict";
import { test } from "node:test";

import { browserThread } from "nanocodex/tools/browser";

test("worker-owned thread metadata keeps the shareable thread identity", () => {
  const id = "12345678-1234-4123-8123-123456789abc";
  const thread = browserThread(id, "https://nanocodex.example/app?ignored=true");

  assert.equal(thread.remoteUrl, `https://nanocodex.example/git/thread-${id}`);
  const share = new URL(thread.shareUrl);
  assert.equal(share.origin, "https://nanocodex.example");
  assert.equal(share.pathname, "/");
  assert.equal(share.searchParams.get("thread"), id);
  assert.equal(share.searchParams.get("ignored"), null);
});

test("worker-owned thread metadata rejects unscoped repository identities", () => {
  assert.throws(
    () => browserThread("../../other-thread", "https://nanocodex.example"),
    /invalid browser thread id/,
  );
});
