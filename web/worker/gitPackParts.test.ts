import assert from "node:assert/strict";
import { test } from "node:test";

import { createRepositoryPartsStream } from "./gitPackParts.ts";
import type { RepositoryPart } from "./gitRepository.ts";

test("repository parts stream the exact stored bytes in order", async () => {
  const objects = new Map([
    ["packs/0000.pack", new Uint8Array([1, 2, 3])],
    ["packs/0001.pack", new Uint8Array([4, 5])],
    ["packs/0002.pack", new Uint8Array([6])],
  ]);
  const bucket = new MemoryBucket(objects);
  const parts = metadata(objects);
  const stream = await createRepositoryPartsStream(bucket as unknown as R2Bucket, parts);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

  assert.deepEqual(bytes, new Uint8Array([1, 2, 3, 4, 5, 6]));
  assert.ok(bucket.maxConcurrentHeads > 1);
  assert.ok(bucket.maxConcurrentHeads <= 4);
});

test("repository parts reject missing and size-mismatched objects before streaming", async () => {
  const missing = new MemoryBucket(new Map());
  await assert.rejects(
    createRepositoryPartsStream(missing as unknown as R2Bucket, [
      { key: "packs/0000.pack", size: 1 },
    ]),
    /missing/,
  );

  const mismatched = new MemoryBucket(new Map([
    ["packs/0000.pack", new Uint8Array([1, 2])],
  ]));
  await assert.rejects(
    createRepositoryPartsStream(mismatched as unknown as R2Bucket, [
      { key: "packs/0000.pack", size: 1 },
    ]),
    /invalid size/,
  );
});

test("repository parts reject a body shorter than its stored metadata", async () => {
  const bucket = {
    head: async () => ({ size: 2 }),
    get: async () => ({
      size: 2,
      body: new Blob([new Uint8Array([1])]).stream(),
    }),
  } as unknown as R2Bucket;
  const stream = await createRepositoryPartsStream(bucket, [
    { key: "packs/0000.pack", size: 2 },
  ]);

  await assert.rejects(new Response(stream).arrayBuffer(), /invalid body/);
});

test("repository part cancellation reaches the active R2 body", async () => {
  let cancelled = false;
  const bucket = {
    head: async () => ({ size: 2 }),
    get: async () => ({
      size: 2,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
  } as unknown as R2Bucket;
  const stream = await createRepositoryPartsStream(bucket, [
    { key: "parts/0000", size: 2 },
  ]);
  const reader = stream.getReader();

  assert.deepEqual(await reader.read(), { done: false, value: new Uint8Array([1]) });
  await reader.cancel();
  assert.equal(cancelled, true);
});

class MemoryBucket {
  readonly objects: Map<string, Uint8Array>;
  maxConcurrentHeads = 0;
  #activeHeads = 0;

  constructor(objects: Map<string, Uint8Array>) {
    this.objects = objects;
  }

  async head(key: string) {
    this.#activeHeads++;
    this.maxConcurrentHeads = Math.max(this.maxConcurrentHeads, this.#activeHeads);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const bytes = this.objects.get(key);
      return bytes == null ? null : { size: bytes.byteLength };
    } finally {
      this.#activeHeads--;
    }
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes == null
      ? null
      : {
          size: bytes.byteLength,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        };
  }
}

function metadata(objects: Map<string, Uint8Array>): RepositoryPart[] {
  return [...objects].map(([key, bytes]) => ({ key, size: bytes.byteLength }));
}
