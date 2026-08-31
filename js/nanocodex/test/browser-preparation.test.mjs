import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrowserEgressFetch,
  installBrowserEgressFetch,
} from "../tools/browser/browserEgress.mjs";
import {
  createPreparedBrowser,
  usePreparedBrowser,
} from "../tools/browser/preparedBrowser.mjs";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

test("binding releases cache ownership while the prepared browser remains reusable", () => {
  const runtime = { origin: "https://nanocodex.test", threadId: THREAD_ID };
  let releases = 0;
  const prepared = createPreparedBrowser(runtime, () => { releases += 1; });

  assert.equal(usePreparedBrowser(prepared), runtime);
  assert.equal(usePreparedBrowser(prepared), runtime);
  assert.equal(releases, 1);

  prepared.dispose();
  prepared.dispose();
  assert.equal(releases, 1);
  assert.throws(() => usePreparedBrowser(prepared), /has been disposed/);
});

test("disposing an unbound prepared browser releases its cache ownership once", () => {
  let releases = 0;
  const prepared = createPreparedBrowser(
    { origin: "https://nanocodex.test", threadId: THREAD_ID },
    () => { releases += 1; },
  );

  prepared.dispose();
  prepared.dispose();
  assert.equal(releases, 1);
  assert.throws(() => usePreparedBrowser(prepared), /has been disposed/);
});

test("binding rejects an unowned prepared-browser shape", () => {
  assert.throws(
    () => usePreparedBrowser({ origin: "https://nanocodex.test", threadId: THREAD_ID }),
    /requires a PreparedBrowser owned by prepareBrowser/,
  );
});

test("browser egress captures credential headers instead of observing later mutation", async () => {
  const headers = { authorization: "Bearer original" };
  let authorization;
  const route = createBrowserEgressFetch({
    origin: "https://nanocodex.test",
    threadId: THREAD_ID,
    headers,
    async fetch(_input, init) {
      authorization = new Headers(init.headers).get("authorization");
      return new Response(null, { status: 204 });
    },
  });

  headers.authorization = "Bearer rotated";
  await route("https://example.test");
  assert.equal(authorization, "Bearer original");
});

test("installed browser egress refuses a different credential authority", () => {
  const nativeFetch = async () => new Response(null, { status: 204 });
  const options = {
    origin: "https://nanocodex.test",
    threadId: THREAD_ID,
    fetch: nativeFetch,
  };
  const installed = installBrowserEgressFetch({
    ...options,
    headers: { authorization: "Bearer first" },
  });

  assert.equal(installBrowserEgressFetch({
    ...options,
    headers: { authorization: "Bearer first" },
  }), installed);
  assert.throws(() => installBrowserEgressFetch({
    ...options,
    headers: { authorization: "Bearer second" },
  }), /different credential authority/);
});
