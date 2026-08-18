import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  imageGeneration,
  updatePlan,
  viewImage,
  web,
} from "../tools/index.mjs";

const context = Object.freeze({
  callId: "call-1",
  parentCallId: "",
  sessionId: "session-1",
  signal: new AbortController().signal,
});

test("standard tool descriptions stay identical to the Rust-owned Codex contracts", async () => {
  const [webDescription, imageDescription] = await Promise.all([
    readFile(new URL("../../../crates/nanocodex-tools/src/web_search/web_run_description.md", import.meta.url), "utf8"),
    readFile(new URL("../../../crates/nanocodex-tools/src/image_generation/imagegen_description.md", import.meta.url), "utf8"),
  ]);
  assert.equal(web().description, webDescription.trimEnd());
  assert.equal(imageGeneration().description, imageDescription.trimEnd());
});

test("web forwards the complete command object through a caller-owned host adapter", async () => {
  const requests = [];
  const tool = web({
    url: "https://host.test/tools/web",
    headers: { authorization: "Bearer host" },
    async fetch(url, init) {
      requests.push({ url, init });
      return Response.json({ output: "searched" });
    },
  });

  assert.equal(tool.name, "web__run");
  assert.deepEqual(await tool.handler({ search_query: [{ q: "nanocodex" }] }, context), "searched");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    commands: { search_query: [{ q: "nanocodex" }] },
    session_id: "session-1",
  });
  assert.equal(requests[0].init.headers.authorization, "Bearer host");
  assert.equal(requests[0].init.signal, context.signal);
  assert.deepEqual(tool.parameters.properties.search_query.items.required, ["q"]);
  assert.deepEqual(tool.parameters.properties.response_length.enum, ["short", "medium", "long"]);
});

test("web repairs common non-array model argument shapes before host dispatch", async () => {
  const bodies = [];
  const tool = web({
    url: "https://host.test/web",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({ output: "ok" });
    },
  });
  await tool.handler({ commands: { search_query: { q: "nanocodex" } } }, context);
  await tool.handler({ image_query: "rust wasm", open: "turn1search0" }, context);
  assert.deepEqual(bodies.map(({ commands }) => commands), [
    { search_query: [{ q: "nanocodex" }] },
    { image_query: [{ q: "rust wasm" }], open: [{ ref_id: "turn1search0" }] },
  ]);
});

test("web and image generation default to the standard same-origin host routes", async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return Response.json(url.includes("web-search")
      ? { output: "ok" }
      : { image_url: "data:image/png;base64,image" });
  };
  await web({ fetch }).handler({ search_query: [{ q: "nanocodex" }] }, context);
  await imageGeneration({ fetch }).handler({ prompt: "draw it" }, context);
  assert.deepEqual(urls, ["/api/tools/web-search", "/api/tools/image-generation"]);
});

test("image generation resolves recent session images without owning conversation state", async () => {
  const remembered = [];
  const tool = imageGeneration({
    url: new URL("https://host.test/tools/images"),
    recentImages: (_sessionId, count) => ["data:image/png;base64,one"].slice(0, count),
    rememberImage: (sessionId, imageUrl) => remembered.push({ sessionId, imageUrl }),
    async fetch(_url, init) {
      assert.deepEqual(JSON.parse(init.body), {
        images: ["data:image/png;base64,one"],
        prompt: "edit it",
      });
      return Response.json({ image_url: "data:image/png;base64,two" });
    },
  });

  assert.deepEqual(await tool.handler({ prompt: "edit it", num_last_images_to_include: 1 }, context), {
    image_url: "data:image/png;base64,two",
  });
  assert.deepEqual(remembered, [{
    sessionId: "session-1",
    imageUrl: "data:image/png;base64,two",
  }]);
});

test("each factory returns an immutable named tool for direct array composition", () => {
  assert(Object.isFrozen(updatePlan()));
  assert.equal(viewImage({ workspace: { readFile: async () => new Uint8Array() } }).name, "view_image");
});

test("image generation implements the canonical workspace-path edit mode", async () => {
  const tool = imageGeneration({
    url: "https://host.test/tools/images",
    workspace: {
      readFile: async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.images[0], "data:image/png;base64,iVBORw0KGgo=");
      return Response.json({ image_url: "data:image/png;base64,result" });
    },
  });
  assert.deepEqual(tool.parameters.properties.referenced_image_paths.type, ["array", "null"]);
  await tool.handler({ prompt: "edit", referenced_image_paths: ["/workspace/input.png"] }, context);
  await assert.rejects(
    tool.handler({
      prompt: "edit",
      referenced_image_paths: ["/workspace/input.png"],
      num_last_images_to_include: 1,
    }, context),
    /not both/,
  );
});
