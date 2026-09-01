import assert from "node:assert/strict";
import { test } from "node:test";

import { viewImage } from "nanocodex/tools";

test("view_image returns browser workspace images to the model and Code Mode", async () => {
  const tool = viewImage({
    workspace: {
      async readFile(path) {
        assert.equal(path, "/workspace/pixel.png");
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      },
    },
  });
  const result = await tool.handler(
    { path: "/workspace/pixel.png", detail: "original" },
    {
      callId: "call-1",
      parentCallId: "",
      sessionId: "session-1",
      signal: new AbortController().signal,
    },
  ) as {
    output: Array<{ detail: string; image_url: string; type: string }>;
    structuredResult: { detail: string; image_url: string };
  };
  assert.deepEqual(result.output, [{
    detail: "original",
    image_url: "data:image/png;base64,iVBORw0KGgo=",
    type: "input_image",
  }]);
  assert.deepEqual(result.structuredResult, {
    detail: "original",
    image_url: "data:image/png;base64,iVBORw0KGgo=",
  });
});
