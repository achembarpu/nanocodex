import assert from "node:assert/strict";
import test from "node:test";

import { surfaceFromUrl } from "../src/navigation.ts";
import {
  deviceApiOrigin,
  deviceUserCode,
  productionConnectApiOrigin,
} from "../src/deviceVerification.ts";

test("the CLI verification URL is a canonical main-app route", () => {
  const url = new URL("https://nanocodex.gakonst.workers.dev/connect?user_code=abcd-wxyz");
  assert.equal(surfaceFromUrl(url), "connect");
  assert.equal(deviceUserCode(url.searchParams.get("user_code")), "ABCDWXYZ");
});

test("production verification accepts only the canonical Connect API", () => {
  const pageOrigin = "https://nanocodex.gakonst.workers.dev";
  assert.equal(deviceApiOrigin(null, pageOrigin), productionConnectApiOrigin);
  assert.equal(
    deviceApiOrigin(productionConnectApiOrigin, pageOrigin),
    productionConnectApiOrigin,
  );
  assert.throws(
    () => deviceApiOrigin("http://127.0.0.1:8787", pageOrigin),
    /API origin is invalid/,
  );
});

test("local verification uses the exact same local origin", () => {
  assert.equal(
    deviceApiOrigin(
      "http://nanocodex.localhost:5173",
      "http://nanocodex.localhost:5173",
    ),
    "http://nanocodex.localhost:5173",
  );
  assert.throws(
    () => deviceApiOrigin("http://127.0.0.1:8787", "https://attacker.example"),
    /API origin is invalid/,
  );
  assert.equal(
    deviceApiOrigin("http://localhost:5190", "http://localhost:5190"),
    "http://localhost:5190",
  );
  assert.equal(
    deviceApiOrigin(
      "http://passkey-fix-a1b2c3.nanocodex.localhost:20735",
      "http://passkey-fix-a1b2c3.nanocodex.localhost:20735",
    ),
    "http://passkey-fix-a1b2c3.nanocodex.localhost:20735",
  );
  assert.throws(
    () => deviceApiOrigin(
      "https://nested.evil.nanocodex.local",
      "https://nested.evil.nanocodex.local",
    ),
    /API origin is invalid/,
  );
  assert.throws(
    () => deviceApiOrigin("http://127.0.0.1:5190", "http://localhost:5190"),
    /API origin is invalid/,
  );
  assert.throws(
    () => deviceApiOrigin("https://connect-api.attacker.example", "http://127.0.0.1:5173"),
    /API origin is invalid/,
  );
  assert.throws(
    () => deviceApiOrigin("http://127.0.0.1:8787", "http://nanocodex.localhost:5173"),
    /API origin is invalid/,
  );
});
