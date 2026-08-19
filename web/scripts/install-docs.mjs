import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

const source = new URL("../docs/dist/public/", import.meta.url);
const target = new URL("../dist/client/docs/", import.meta.url);

await rm(target, { force: true, recursive: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

for (const html of await filesWithExtension(target, ".html")) {
  const source = await readFile(html, "utf8");
  const installed = source.replaceAll(
    'href="/#vocs-content"',
    'href="/docs/#vocs-content"',
  );
  if (installed !== source) await writeFile(html, installed);
}

for (const name of ["llms.txt", "llms-full.txt"]) {
  const file = new URL(name, target);
  const source = await readFile(file, "utf8");
  const installed = source
    .replaceAll("](/index)", "](/docs/)")
    .replace(/\]\(\/(?!docs(?:\/|\)))/g, "](/docs/");
  await writeFile(file, installed);
}

async function filesWithExtension(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) return filesWithExtension(path, extension);
    return entry.name.endsWith(extension) ? [path] : [];
  }));
  return files.flat();
}
