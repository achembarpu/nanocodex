import { access, readFile, readdir } from "node:fs/promises";

import { docsBasePath } from "../docs/site.js";

const docs = new URL("../dist/client/docs/", import.meta.url);
const sourcePages = new URL("../docs/src/pages/", import.meta.url);
const pages = [
  ...await mdxRoutes(sourcePages),
  "llms.txt",
  "llms-full.txt",
];

await Promise.all(pages.map((page) => access(new URL(page, docs))));

const index = await readFile(new URL("index.html", docs), "utf8");
assert(index.includes(`href="${docsBasePath}/getting-started"`), "docs navigation is not base-path aware");
assert(index.includes(`href="${docsBasePath}/#vocs-content"`), "skip link escapes the docs base path");
assert(!index.includes('href="/#vocs-content"'), "unscoped skip link remains in docs HTML");

const llms = await readFile(new URL("llms.txt", docs), "utf8");
assert(llms.includes(`](${docsBasePath}/getting-started)`), "llms.txt links are not base-path aware");
assert(!/\]\(\/(?!docs(?:\/|\)))/.test(llms), "llms.txt contains a root-scoped docs link");

async function mdxRoutes(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const routes = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return mdxRoutes(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    }
    if (!entry.name.endsWith(".mdx")) return [];
    const stem = entry.name.slice(0, -".mdx".length);
    return [`${prefix}${stem === "index" ? "" : `${stem}/`}index.html`];
  }));
  return routes.flat();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
