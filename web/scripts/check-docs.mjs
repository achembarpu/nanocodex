import { access, readFile } from "node:fs/promises";

const docs = new URL("../dist/client/docs/", import.meta.url);
const pages = [
  "index.html",
  "getting-started/index.html",
  "stability/index.html",
  "core/owned-agent/index.html",
  "core/tools-code-mode/index.html",
  "core/branching/index.html",
  "sdks/rust/index.html",
  "sdks/javascript/index.html",
  "sdks/python/index.html",
  "capabilities/web-agent/index.html",
  "capabilities/vm-sandboxes/index.html",
  "capabilities/voice/index.html",
  "deployments/index.html",
  "evals/index.html",
  "examples/tact/index.html",
  "llms.txt",
  "llms-full.txt",
];

await Promise.all(pages.map((page) => access(new URL(page, docs))));

const index = await readFile(new URL("index.html", docs), "utf8");
assert(index.includes('href="/docs/getting-started"'), "docs navigation is not base-path aware");
assert(index.includes('href="/docs/#vocs-content"'), "skip link escapes the docs base path");
assert(!index.includes('href="/#vocs-content"'), "unscoped skip link remains in docs HTML");

const llms = await readFile(new URL("llms.txt", docs), "utf8");
assert(llms.includes("](/docs/getting-started)"), "llms.txt links are not base-path aware");
assert(!/\]\(\/(?!docs(?:\/|\)))/.test(llms), "llms.txt contains a root-scoped docs link");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
