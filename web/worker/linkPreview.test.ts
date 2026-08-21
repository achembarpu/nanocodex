import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

import worker from "./index.ts";
import { docsPreview } from "./docsPreview.ts";
import { routeLinkPreview } from "./linkPreview.ts";

const template = `<!doctype html><html><head>
<!-- nanocodex:link-preview:start --><title>stale</title><!-- nanocodex:link-preview:end -->
</head><body></body></html>`;

function assetEnv(environment = "preview") {
  const requests: Request[] = [];
  return {
    env: {
      ENVIRONMENT: environment,
      ASSETS: {
        async fetch(request: Request) {
          requests.push(request);
          return new Response(template, {
            headers: { "content-type": "text/html", etag: '"asset"' },
          });
        },
      },
    },
    requests,
  };
}

test("crawler documents contain complete route-aware production metadata", async () => {
  const { env, requests } = assetEnv("production");
  const request = new Request("https://nanocodex-preview.workers.dev/code?path=src%2F%3Cdriver%3E.rs", {
    headers: { accept: "text/html", "user-agent": "Twitterbot/1.0" },
  });
  const response = await worker.fetch(request, env as never);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(response.headers.has("etag"), false);
  assert.equal(requests[0]?.url, "https://nanocodex-preview.workers.dev/");
  assert.match(html, /<link rel="canonical" href="https:\/\/nanocodex\.paradigm\.xyz\/code\?path=src%2F%3Cdriver%3E\.rs" \/>/);
  assert.match(html, /<meta property="og:type" content="website" \/>/);
  assert.match(html, /<meta property="og:site_name" content="Nanocodex" \/>/);
  assert.match(html, /<meta property="og:image:width" content="1200" \/>/);
  assert.match(html, /<meta property="og:image:height" content="630" \/>/);
  assert.match(html, /<meta property="og:image:type" content="image\/png" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /src\/&lt;driver&gt;\.rs · Nanocodex/);
  assert.doesNotMatch(html, /<driver>/);
});

test("document routing handles browser navigation, HEAD, and unknown paths", async () => {
  const { env } = assetEnv();
  const browserRequest = new Request("https://preview.test/changelog", {
    headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
  });
  const browserResponse = await routeLinkPreview(browserRequest, env as never, new URL(browserRequest.url));
  assert.match(await browserResponse!.text(), /Changelog · Nanocodex/);

  const headRequest = new Request("https://preview.test/docs/unknown-page", {
    method: "HEAD",
    headers: { accept: "text/html" },
  });
  const headResponse = await routeLinkPreview(headRequest, env as never, new URL(headRequest.url));
  assert.equal(headResponse?.status, 200);
  assert.equal(await headResponse?.text(), "");

  const unknownRequest = new Request("https://preview.test/not-an-app-route", {
    headers: { accept: "text/html" },
  });
  const unknownResponse = await routeLinkPreview(unknownRequest, env as never, new URL(unknownRequest.url));
  const unknownHtml = await unknownResponse!.text();
  assert.match(unknownHtml, /href="https:\/\/preview\.test\/"/);
  assert.match(unknownHtml, /Nanocodex — high-performance Codex SDK/);

  const scriptRequest = new Request("https://preview.test/docs.js", {
    headers: { accept: "application/javascript", "sec-fetch-dest": "script" },
  });
  assert.equal(await routeLinkPreview(scriptRequest, env as never, new URL(scriptRequest.url)), null);
});

test("eval entity names are read safely with deterministic fallbacks", async () => {
  const values: unknown[][] = [];
  const env = {
    ...assetEnv().env,
    EVALS_DB: {
      prepare(query: string) {
        return {
          bind(...bound: unknown[]) {
            values.push(bound);
            return {
              async first() {
                return query.includes("JOIN task_definitions")
                  ? { name: "fix <unsafe> & ship", profile: "terminal-bench" }
                  : { profile: "terminal-bench", task_count: 89 };
              },
            };
          },
        };
      },
    },
  };
  const request = new Request(
    "https://preview.test/evals/worksets/suite%20one/tasks/fix%2Fgit",
    { headers: { accept: "text/html" } },
  );
  const response = await routeLinkPreview(request, env as never, new URL(request.url));
  const html = await response!.text();
  assert.deepEqual(values, [["suite one", "fix/git"]]);
  assert.match(html, /fix &lt;unsafe&gt; &amp; ship · Nanocodex/);
  assert.match(html, /retained terminal-bench treatments/);

  const malformed = new Request(
    "https://preview.test/evals/worksets/%E0%A4%A/tasks/run",
    { headers: { accept: "text/html" } },
  );
  const fallback = await routeLinkPreview(malformed, assetEnv().env as never, new URL(malformed.url));
  assert.match(await fallback!.text(), /Evaluation run · Nanocodex/);
});

test("generated PNGs are cacheable, deterministic, bounded, and conditional", async () => {
  const request = new Request("https://preview.test/og.png?path=%2Fdocs%2Fcore%2Fowned-agent");
  const response = await routeLinkPreview(request, {}, new URL(request.url));
  const bytes = new Uint8Array(await response!.arrayBuffer());
  assert.equal(response?.headers.get("content-type"), "image/png");
  assert.equal(response?.headers.get("cache-control"), "public, max-age=86400, stale-while-revalidate=604800");
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.length > 1_000 && bytes.length < 100_000);

  const etag = response!.headers.get("etag")!;
  const conditional = new Request(request, { headers: { "if-none-match": etag } });
  const notModified = await routeLinkPreview(conditional, {}, new URL(conditional.url));
  assert.equal(notModified?.status, 304);
  assert.equal(notModified?.headers.get("etag"), etag);

  const hostile = new Request(`https://preview.test/og.png?path=${encodeURIComponent(`//evil.test/${"x".repeat(1100)}`)}`);
  const bounded = await routeLinkPreview(hostile, {}, new URL(hostile.url));
  assert.equal(bounded?.status, 200);
  assert.ok((await bounded!.arrayBuffer()).byteLength < 100_000);
});

test("Cloudflare routes every preview-owning document and image through the Worker", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.assets.run_worker_first.slice(0, 10), [
    "/", "/agent", "/changelog", "/code", "/commits", "/docs", "/docs/*", "/evals", "/evals/*", "/og.png",
  ]);
});

test("the compact Worker docs projection matches every source frontmatter entry", async () => {
  const root = new URL("../docs/src/pages/", import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".mdx"));
  const projected = new Set<string>();
  for (const file of files) {
    const relative = file.replace(/\.mdx$/, "");
    const route = relative === "index" ? "/docs" : `/docs/${relative}`;
    const source = await readFile(new URL(file, root), "utf8");
    const read = (name: string) => source.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))
      ?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
    assert.deepEqual(docsPreview[route as keyof typeof docsPreview], [read("title"), read("description")], route);
    projected.add(route);
  }
  assert.deepEqual(new Set(Object.keys(docsPreview)), projected);
});
