import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const sourcePages = new URL("../docs/src/pages/", import.meta.url);
const client = new URL("../dist/client/", import.meta.url);
const docsOutput = new URL("docs/", client);
const pages = await markdownPages(sourcePages);

await access(new URL("index.html", client));
const assets = await readdir(new URL("assets/", client));
const JavaScript = assets.filter((name) => name.endsWith(".js"));
const bundled = (await Promise.all(
  JavaScript.map((name) => readFile(new URL(`assets/${name}`, client), "utf8")),
)).join("\n");

assert(bundled.includes("Copy markdown"), "the native documentation surface is missing");
assert(bundled.includes("That page is not in the manual"), "the docs not-found boundary is missing");
for (const page of pages) {
  assert(bundled.includes(page.title), `the docs bundle omits ${page.route}`);
}

await mkdir(docsOutput, { recursive: true });
const index = [
  "# Nanocodex documentation",
  "",
  "A library-first Rust agent SDK with JavaScript, browser, and Python bindings.",
  "",
  ...pages.map(({ title, description, route }) =>
    `- [${title}](${route})${description ? ` — ${description}` : ""}`
  ),
  "",
].join("\n");
const full = pages.map(({ route, source }) =>
  `Source: ${route}\n\n${rewriteLinks(stripFrontmatter(source))}`
).join("\n\n---\n\n");
await writeFile(new URL("llms.txt", docsOutput), index);
await writeFile(new URL("llms-full.txt", docsOutput), full);

async function markdownPages(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const pages = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return markdownPages(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    }
    if (!entry.name.endsWith(".mdx")) return [];
    const source = await readFile(new URL(entry.name, directory), "utf8");
    const stem = entry.name.slice(0, -4);
    const relative = `${prefix}${stem}`;
    return [{
      route: relative === "index" ? "/docs" : `/docs/${relative}`,
      title: frontmatter(source, "title") ?? relative,
      description: frontmatter(source, "description") ?? "",
      source,
    }];
  }));
  return pages.flat().sort((left, right) => left.route.localeCompare(right.route));
}

function frontmatter(source, name) {
  return source.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, "$2");
}

function stripFrontmatter(source) {
  return source.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function rewriteLinks(source) {
  return source.replace(/\]\(\/(?!docs(?:\/|\)))/g, "](/docs/");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
