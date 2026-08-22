import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const LABEL = /^[a-z0-9_-]{1,64}$/;
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_DESCRIPTORS = 16;

export function secretDigestDescriptors(values) {
  if (!Array.isArray(values) || values.length > MAX_DESCRIPTORS) {
    throw new Error(`secret scan accepts at most ${MAX_DESCRIPTORS} values`);
  }
  return values.map(({ label, value }) => {
    const byteLength = typeof value === "string" ? Buffer.byteLength(value) : 0;
    if (!LABEL.test(String(label)) || byteLength < 1 || byteLength > MAX_SECRET_BYTES) {
      throw new Error(`cannot scan invalid forbidden public value ${label}`);
    }
    return Object.freeze({
      label,
      byte_length: byteLength,
      sha256: createHash("sha256").update(value).digest("hex"),
    });
  });
}

export function parseSecretDigestDescriptors(encoded) {
  if (!encoded) return [];
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("secret digest descriptors must be JSON");
  }
  if (!Array.isArray(value) || value.length > MAX_DESCRIPTORS) {
    throw new Error(`secret digest list must contain at most ${MAX_DESCRIPTORS} entries`);
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !SHA256.test(String(entry.sha256))
      || !Number.isSafeInteger(entry.byte_length)
      || entry.byte_length < 1
      || entry.byte_length > MAX_SECRET_BYTES
      || !LABEL.test(String(entry.label))) {
      throw new Error("secret digest descriptor is invalid");
    }
    return Object.freeze({
      label: entry.label,
      byte_length: entry.byte_length,
      sha256: entry.sha256,
    });
  });
}

export function assertNoSecretDigestMatches(encoded, descriptors) {
  const bytes = Buffer.from(encoded);
  for (const descriptor of descriptors) {
    const last = bytes.byteLength - descriptor.byte_length;
    for (let offset = 0; offset <= last; offset += 1) {
      const digest = createHash("sha256")
        .update(bytes.subarray(offset, offset + descriptor.byte_length))
        .digest("hex");
      if (digest === descriptor.sha256) {
        throw new Error(`public Multiplayer traffic exposed ${descriptor.label}`);
      }
    }
  }
}
