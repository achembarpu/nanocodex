import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadWorldAssets } from "../src/monsterWorldRenderer.ts";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const WORLD_ASSET_ROOT = "/world/my-pixel-world/";

test("the decoded World asset set is byte-versioned and exactly immutable", async () => {
  const decodedSources: string[] = [];
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");

  class DecodedImage {
    src = "";

    decode(): Promise<void> {
      decodedSources.push(this.src);
      return this.src.includes("/character-overworld/ow3.png?")
        ? Promise.reject(new Error("synthetic decode failure"))
        : Promise.resolve();
    }
  }

  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    writable: true,
    value: DecodedImage,
  });

  try {
    const assets = await loadWorldAssets();
    assert.equal(
      assets.humans[3],
      undefined,
      "decode failures must remain optional assets rather than rejecting the load",
    );
  } finally {
    if (originalImage) {
      Object.defineProperty(globalThis, "Image", originalImage);
    } else {
      Reflect.deleteProperty(globalThis, "Image");
    }
  }

  assert.equal(decodedSources.length, 27);
  const urls = decodedSources.map((source) => new URL(source, "https://nanocodex.dev"));
  const paths = urls.map((url) => url.pathname);
  assert.equal(new Set(paths).size, 27, "every decoded asset must have a unique URL");

  const versions = new Set(urls.map((url) => {
    assert.equal([...url.searchParams].length, 1);
    return url.searchParams.get("v");
  }));
  assert.equal(versions.size, 1, "all World assets must share one content version");
  const [version] = versions;
  assert.match(version ?? "", /^[a-f0-9]{64}$/);

  const digest = createHash("sha256");
  for (const path of [...paths].sort()) {
    digest.update(path);
    digest.update("\0");
    digest.update(await readFile(new URL(`../public${path}`, import.meta.url)));
  }
  assert.equal(
    version,
    digest.digest("hex"),
    "change the renderer version whenever any loaded asset path or byte changes",
  );

  const headers = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
  const immutableWorldPaths = headerRules(headers)
    .filter(({ path, values }) =>
      path.startsWith(WORLD_ASSET_ROOT)
      && values.includes(`Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`)
    )
    .map(({ path }) => path)
    .sort();
  assert.deepEqual(
    immutableWorldPaths,
    [...paths].sort(),
    "only the renderer's exact, versioned asset set may be immutable",
  );
  assert.ok(immutableWorldPaths.every((path) => !/[?:*]/.test(path)));
  assert.equal(
    headerRules(headers).find(({ path }) => path === "/*")?.values.some((value) =>
      value.startsWith("Cache-Control:")
    ),
    false,
    "the document catch-all must not become immutable",
  );
});

function headerRules(input: string): ReadonlyArray<Readonly<{
  path: string;
  values: string[];
}>> {
  const rules: Array<{ path: string; values: string[] }> = [];
  let current: { path: string; values: string[] } | undefined;

  for (const line of input.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = { path: line.trim(), values: [] };
      rules.push(current);
      continue;
    }
    current?.values.push(line.trim());
  }

  return rules;
}
