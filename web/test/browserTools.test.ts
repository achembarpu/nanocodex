import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrowserTools } from "../src/browserTools.ts";

test("view_image returns browser workspace images to Code Mode", async () => {
  const tools = createBrowserTools({
    recentImages: () => [],
    rememberImage: () => undefined,
    workspace: {
      async readFile(path) {
        assert.equal(path, "/workspace/pixel.png");
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      },
    },
  });
  const result = await tools.view_image.handler(
    { path: "/workspace/pixel.png", detail: "original" },
    { sessionId: "session-1" },
  ) as { detail: string; image_url: string };
  assert.equal(result.detail, "original");
  assert.equal(result.image_url, "data:image/png;base64,iVBORw0KGgo=");
});
