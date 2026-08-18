import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { createThreadPackStream } from "./threadPack.ts";
import type { ThreadPack } from "./threadRepository.ts";

test("composes retained source packs into one strict Git pack", async () => {
  const first = sourcePack("first blob\n");
  const second = sourcePack("second blob\n");
  const headA = gitBlobOid("first blob\n");
  const headB = gitBlobOid("second blob\n");
  const firstMetadata = metadata("first.pack", first, "0".repeat(40), headA);
  const secondMetadata = metadata("second.pack", second, headA, headB);
  const bucket = new MemoryBucket(new Map([
    [firstMetadata.key, first],
    [secondMetadata.key, second],
  ]));
  const stream = await createThreadPackStream(bucket as unknown as R2Bucket, [
    firstMetadata,
    secondMetadata,
  ]);
  const combined = await readStream(stream);

  assert.equal(new TextDecoder().decode(combined.subarray(0, 4)), "PACK");
  const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
  assert.equal(view.getUint32(4), 2);
  assert.equal(view.getUint32(8), 2);
  assert.deepEqual(
    combined.subarray(12, -20),
    concatenate([first.subarray(12, -20), second.subarray(12, -20)]),
  );
  assert.deepEqual(
    combined.subarray(-20),
    sha1(combined.subarray(0, -20)),
  );
  await assertGitAccepts(combined);
  const suffix = await readStream(await createThreadPackStream(
    bucket as unknown as R2Bucket,
    [secondMetadata],
  ));
  await assertGitAcceptsAfter(first, headA, suffix);
  assert.ok(bucket.maxConcurrentHeads > 1);
  assert.ok(bucket.maxConcurrentHeads <= 4);
  assert.deepEqual(bucket.deleted, []);
});

test("rejects missing and corrupted retained packs", async () => {
  const bytes = sourcePack("fixture\n");
  const missing = new MemoryBucket(new Map());
  await assert.rejects(
    createThreadPackStream(missing as unknown as R2Bucket, [
      metadata("missing.pack", bytes, "0".repeat(40), "a".repeat(40)),
    ]),
    /missing/,
  );

  const corrupted = bytes.slice();
  corrupted[12] ^= 1;
  const corruptedMetadata = metadata(
    "corrupt.pack",
    bytes,
    "0".repeat(40),
    "a".repeat(40),
  );
  const bucket = new MemoryBucket(new Map([[corruptedMetadata.key, corrupted]]));
  const stream = await createThreadPackStream(bucket as unknown as R2Bucket, [
    corruptedMetadata,
  ]);
  await assert.rejects(readStream(stream), /checksum/);
});

class MemoryBucket {
  readonly deleted: string[] = [];
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
      return bytes ? { size: bytes.byteLength } : null;
    } finally {
      this.#activeHeads--;
    }
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes
      ? { arrayBuffer: async () => bytes.slice().buffer }
      : null;
  }

  async delete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

function sourcePack(contents: string): Uint8Array {
  const object = new TextEncoder().encode(contents);
  assert.ok(object.byteLength < 16);
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("PACK"));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, 1);
  const entry = concatenate([
    Uint8Array.of((3 << 4) | object.byteLength),
    deflateSync(object),
  ]);
  const body = concatenate([header, entry]);
  return concatenate([body, sha1(body)]);
}

function metadata(
  key: string,
  bytes: Uint8Array,
  oldOid: string,
  newOid: string,
): ThreadPack {
  return {
    key: `thread-repositories/thread-12345678-1234-4123-8123-123456789abc/${key}`,
    hash: Buffer.from(bytes.subarray(-20)).toString("hex"),
    size: bytes.byteLength,
    objectCount: 1,
    oldOid,
    newOid,
  };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  return concatenate(chunks);
}

async function assertGitAccepts(pack: Uint8Array): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), "nanocodex-thread-pack-"));
  try {
    await run("git", ["init", "--bare", "-q"], directory);
    await run("git", ["index-pack", "--stdin", "--strict"], directory, pack);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertGitAcceptsAfter(
  firstPack: Uint8Array,
  firstOid: string,
  suffix: Uint8Array,
): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), "nanocodex-thread-suffix-"));
  try {
    await run("git", ["init", "--bare", "-q"], directory);
    await run("git", ["index-pack", "--stdin", "--strict"], directory, firstPack);
    await run("git", ["cat-file", "-e", firstOid], directory);
    await run("git", ["index-pack", "--stdin", "--strict"], directory, suffix);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function run(command: string, args: string[], cwd: string, input?: Uint8Array): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

function sha1(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha1").update(bytes).digest());
}

function gitBlobOid(contents: string): string {
  const bytes = new TextEncoder().encode(contents);
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
