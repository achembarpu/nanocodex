import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoSecretDigestMatches,
  parseSecretDigestDescriptors,
  secretDigestDescriptors,
} from "../scripts/public-secret-scan.mjs";

test("public secret scanning detects an exact secret without giving it to the client", () => {
  const secret = "provider-secret-00000000000000000000000000000000";
  const encoded = JSON.stringify(secretDigestDescriptors([
    { label: "provider_secret", value: secret },
  ]));
  assert.doesNotMatch(encoded, new RegExp(secret));
  const descriptors = parseSecretDigestDescriptors(encoded);
  assert.doesNotThrow(() => assertNoSecretDigestMatches("public room reply", descriptors));
  assert.throws(
    () => assertNoSecretDigestMatches(`prefix🙂Bearer ${secret}:suffix`, descriptors),
    /exposed provider_secret/,
  );
});
