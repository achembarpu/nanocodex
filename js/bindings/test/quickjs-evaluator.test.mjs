import assert from "node:assert/strict";
import test from "node:test";

import asyncVariant from "@jitl/quickjs-wasmfile-release-asyncify";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";

import { createCodeRuntime } from "../runtime/code-runtime.mjs";
import { createQuickJsEvaluator } from "../runtime/quickjs-evaluator.mjs";

const quickJs = await newQuickJSAsyncWASMModuleFromVariant(asyncVariant);

test("QuickJS evaluator runs async Code Mode tools without host eval", async () => {
  const runtime = createCodeRuntime({
    add: {
      description: "Add two values.",
      parameters: { type: "object" },
      async handler({ left, right }) {
        await Promise.resolve();
        return left + right;
      },
    },
  }, { evaluate: createQuickJsEvaluator(quickJs) });

  const first = JSON.parse(await runtime.executeCode(`
    const sum = await tools.add({ left: 20, right: 22 });
    store("sum", sum);
    text({ sum, available: ALL_TOOLS.map((tool) => tool.name) });
  `, "quickjs", "exec-1"));
  assert.equal(first.success, true);
  assert.match(JSON.stringify(first.output), /sum/);
  assert.match(JSON.stringify(first.output), /42/);
  assert.deepEqual(first.nested_calls.map((call) => call.name), ["add"]);

  const second = JSON.parse(await runtime.executeCode(`text(load("sum"));`, "quickjs", "exec-2"));
  assert.equal(second.success, true);
  assert.match(JSON.stringify(second.output), /42/);
});

test("QuickJS evaluator reports guest failures as Code Mode failures", async () => {
  const runtime = createCodeRuntime({}, { evaluate: createQuickJsEvaluator(quickJs) });
  const result = JSON.parse(await runtime.executeCode(`throw new Error("guest exploded")`));
  assert.equal(result.success, false);
  assert.match(result.output, /guest exploded/);
});

test("Code Mode cancellation aborts active nested tools", async () => {
  let started;
  const toolStarted = new Promise((resolve) => { started = resolve; });
  const runtime = createCodeRuntime({
    blocked: {
      async handler(_input, context) {
        started();
        await new Promise((resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("nested tool cancelled")), {
            once: true,
          });
        });
      },
    },
  }, { evaluate: createQuickJsEvaluator(quickJs) });
  const execution = runtime.executeCode("await tools.blocked({});", "cancel", "exec-cancel");
  await toolStarted;
  runtime.cancel();
  const result = JSON.parse(await execution);
  assert.equal(result.success, false);
  assert.match(result.output, /nested tool cancelled/);
});
