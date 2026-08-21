import assert from "node:assert/strict";
import { test } from "node:test";

import { proxyDefaultMcp } from "./mcpProxy.ts";

test("default MCP proxy is same-origin, allowlisted, and preserves protocol state", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ request: Request; url: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ request, url: request.url });
    return new Response("event: message\ndata: {}\n\n", {
      headers: {
        "content-type": "text/event-stream",
        "mcp-session-id": "session-2",
        "set-cookie": "must-not-leak=1",
      },
    });
  }) as typeof fetch;
  try {
    const url = new URL("https://demo.test/api/mcp/cloudflare?cursor=next");
    const response = await proxyDefaultMcp(new Request(url, {
      method: "POST",
      headers: {
        authorization: "must-not-forward",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": "session-1",
      },
      body: "{}",
    }), url, true);

    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get("content-type"), "text/event-stream");
    assert.equal(response?.headers.get("mcp-session-id"), "session-2");
    assert.equal(response?.headers.get("set-cookie"), null);
    assert.equal(seen[0]?.url, "https://docs.mcp.cloudflare.com/mcp?cursor=next");
    assert.equal(seen[0]?.request.headers.get("authorization"), null);
    assert.equal(seen[0]?.request.headers.get("mcp-session-id"), "session-1");
    assert.equal(await seen[0]?.request.text(), "{}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default MCP proxy rejects forged origins, unknown servers, and methods", async () => {
  const url = new URL("https://demo.test/api/mcp/cloudflare");
  assert.equal((await proxyDefaultMcp(new Request(url), url, false))?.status, 403);

  const unknown = new URL("https://demo.test/api/mcp/arbitrary");
  assert.equal((await proxyDefaultMcp(new Request(unknown), unknown, true))?.status, 404);

  assert.equal((await proxyDefaultMcp(new Request(url, { method: "PUT" }), url, true))?.status, 405);
  assert.equal(await proxyDefaultMcp(new Request("https://demo.test/api/other"), new URL("https://demo.test/api/other"), true), undefined);
});

test("default MCP proxy rejects declared oversized bodies before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response();
  }) as typeof fetch;
  try {
    const url = new URL("https://demo.test/api/mcp/cloudflare");
    const response = await proxyDefaultMcp(new Request(url, {
      method: "POST",
      headers: { "content-length": String(16 * 1024 * 1024 + 1) },
      body: "{}",
    }), url, true);

    assert.equal(response?.status, 413);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default MCP proxy cancels chunked bodies at the streaming cap without fetching upstream", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  let cancelled = false;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response();
  }) as typeof fetch;
  try {
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunk++ === 0) controller.enqueue(new Uint8Array(16 * 1024 * 1024));
        else controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const url = new URL("https://demo.test/api/mcp/cloudflare");
    const response = await proxyDefaultMcp(new Request(url, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }), url, true);

    assert.equal(response?.status, 413);
    assert.equal(cancelled, true);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
