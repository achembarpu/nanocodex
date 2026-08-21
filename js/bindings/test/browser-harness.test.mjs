import assert from "node:assert/strict";
import { test } from "node:test";

import { bindBrowser } from "../tools/browser/index.mjs";
import * as datasets from "../tools/dataset.mjs";
import { namedTool } from "../tools/namedTool.mjs";
import * as standard from "../tools/standard.mjs";

const context = Object.freeze({
  callId: "browser-harness-call",
  parentCallId: "",
  sessionId: "browser-harness-session",
  signal: new AbortController().signal,
});

test("the default browser harness exposes one exact model-visible tool set", async () => {
  const workspace = {
    async readFile(path) {
      assert.equal(path, "/workspace/pixel.png");
      return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    },
  };
  const runtime = bindBrowser({
    datasets,
    origin: "https://demo.test",
    standard,
    threadId: "browser-harness-thread",
    shell: {
      artifactTool: namedTool("render_artifact", {
        description: "Render an artifact.",
        handler: async () => ({ artifactId: "ui" }),
      }),
      execTool: {
        description: "Run a command.",
        handler: async ({ cmd }) => ({ exit_code: 0, output: `${cmd}\n` }),
      },
      instructions: "browser harness",
      projectInstructions: "project instructions",
      workspace,
    },
  }, {
    dataset: {
      fetch: async () => new Response('{"id":1}\n'),
    },
    images: {
      fetch: async () => Response.json({ image_url: "data:image/png;base64,Z2VuZXJhdGVk" }),
    },
    web: {
      fetch: async () => Response.json({ output: "searched" }),
    },
  });

  assert.equal(runtime.filesystem, workspace);
  assert.equal(runtime.instructions, "browser harness");
  assert.equal(runtime.projectInstructions, "project instructions");
  assert.deepEqual(runtime.tools.map(({ name }) => name), [
    "exec_command",
    "web__run",
    "image_gen__imagegen",
    "view_image",
    "update_plan",
    "dataset",
    "render_artifact",
  ]);
  assert(runtime.tools.every((tool) => Object.isFrozen(tool)));

  const byName = Object.fromEntries(runtime.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(await byName.exec_command.handler({ cmd: "pwd" }, context), {
    exit_code: 0,
    output: "pwd\n",
  });
  assert.equal(await byName.web__run.handler({ time: [{ utc_offset: "+03:00" }] }, context), "searched");
  assert.deepEqual(await byName.image_gen__imagegen.handler({ prompt: "draw" }, context), {
    image_url: "data:image/png;base64,Z2VuZXJhdGVk",
  });
  assert.equal(
    (await byName.view_image.handler({ path: "/workspace/pixel.png" }, context)).image_url,
    "data:image/png;base64,iVBORw0KGgo=",
  );
  assert.deepEqual(await byName.update_plan.handler({ plan: [] }, context), { updated: true });
  const opened = await byName.dataset.handler({
    operation: "open",
    source: {
      kind: "url",
      url: "https://data.example/browser-harness.jsonl",
      format: "jsonl",
    },
  }, context);
  assert.deepEqual(opened.previewRows, [{ id: 1 }]);
  assert.deepEqual(await byName.render_artifact.handler({}, context), { artifactId: "ui" });
});
