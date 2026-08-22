import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import ts from "typescript";

test("the emitted inline browser client is valid JavaScript", async () => {
  const source = await readFile(new URL("../src/web.ts", import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(transpiled, {
    exports: loaded.exports,
    module: loaded,
    Response,
  });
  const response = loaded.exports.webAsset("/app.js");
  const app = await response.text();
  new vm.Script(app, { filename: "app.js" });
});
