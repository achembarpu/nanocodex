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
  const requests = [];
  const workspace = {
    async readFile(path) {
      assert.equal(path, "/workspace/pixel.png");
      return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    },
  };
  const runtime = bindBrowser({
    datasets,
    fetch: async (input) => {
      requests.push(String(input));
      return Response.json({
        connectors: {
          github: { connected: true, label: "Nano Cat (nanocat)", account_id: "hidden" },
          gmail: { connected: false },
          gdrive: { connected: true, label: "Drive User", access_token: "hidden" },
        },
      });
    },
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
      fetch: async (input, init) => {
        requests.push(new Request(input, init).url);
        return Response.json({ image_url: "data:image/png;base64,Z2VuZXJhdGVk" });
      },
    },
    web: {
      fetch: async (input, init) => {
        requests.push(new Request(input, init).url);
        return Response.json({ output: "searched" });
      },
    },
  });

  assert.equal(runtime.filesystem, workspace);
  assert.equal(runtime.instructions, "browser harness");
  assert.equal(runtime.projectInstructions, "project instructions");
  assert.deepEqual(runtime.tools.map(({ name }) => name), [
    "exec_command",
    "runtimeInfo",
    "connectorEgress",
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
  const connectorEgress = await byName.connectorEgress.handler({}, context);
  assert.deepEqual(connectorEgress, {
    status: "ready",
    authenticated: ["github", "gdrive"],
    accounts: { github: "Nano Cat (nanocat)", gdrive: "Drive User" },
  });
  assert.deepEqual((await byName.runtimeInfo.handler({}, context)).connector_egress, connectorEgress);
  assert.equal(await byName.web__run.handler({ time: [{ utc_offset: "+03:00" }] }, context), "searched");
  assert.deepEqual(await byName.image_gen__imagegen.handler({ prompt: "draw" }, context), {
    image_url: "data:image/png;base64,Z2VuZXJhdGVk",
  });
  assert.deepEqual(requests, [
    "https://demo.test/v1/connectors",
    "https://demo.test/v1/connectors",
    "https://demo.test/api/tools/web-search",
    "https://demo.test/api/tools/image-generation",
  ]);
  const viewed = await byName.view_image.handler({ path: "/workspace/pixel.png" }, context);
  assert.deepEqual(viewed.output, [{
    type: "input_image",
    image_url: "data:image/png;base64,iVBORw0KGgo=",
    detail: "high",
  }]);
  assert.equal(viewed.structuredResult.image_url, "data:image/png;base64,iVBORw0KGgo=");
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

test("the browser harness preserves explicit tool URLs", async () => {
  const urls = [];
  const runtime = bindBrowser(preparedBrowser(), {
    web: {
      url: "https://tools.test/search",
      fetch: async (input) => {
        urls.push(String(input));
        return Response.json({ output: "searched" });
      },
    },
    images: {
      url: "https://tools.test/images",
      fetch: async (input) => {
        urls.push(String(input));
        return Response.json({ image_url: "data:image/png;base64,Z2VuZXJhdGVk" });
      },
    },
  });
  const byName = Object.fromEntries(runtime.tools.map((tool) => [tool.name, tool]));
  await byName.web__run.handler({ search_query: [{ q: "override" }] }, context);
  await byName.image_gen__imagegen.handler({ prompt: "override" }, context);
  assert.deepEqual(urls, ["https://tools.test/search", "https://tools.test/images"]);
});

function preparedBrowser() {
  const workspace = { async readFile() { return new Uint8Array(); } };
  return {
    datasets,
    fetch: async () => Response.json({ connectors: {} }),
    origin: "https://demo.test",
    standard,
    threadId: "browser-harness-overrides",
    shell: {
      artifactTool: namedTool("render_artifact", {
        description: "Render an artifact.",
        handler: async () => ({ artifactId: "ui" }),
      }),
      execTool: { description: "Run a command.", handler: async () => ({}) },
      instructions: "browser harness",
      projectInstructions: "project instructions",
      workspace,
    },
  };
}
