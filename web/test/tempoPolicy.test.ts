import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MPP_ACCESS_KEY_LIMIT,
  MPP_ACCESS_KEY_SCOPES,
  MPP_ESCROW,
  MPP_MIN_WALLET_BALANCE,
  MPP_MODEL_CHANNEL_LIMIT,
  MPP_PAYMENT_TOKENS,
  PATH_USD,
  USDC_E,
} from "../src/tempo-policy.ts";

test("MPP access-key policy covers model and paid Mercator flows with bounded tokens", () => {
  assert.deepEqual(MPP_PAYMENT_TOKENS, [USDC_E, PATH_USD]);
  assert.equal(USDC_E, "0x20c000000000000000000000b9537d11c60e8b50");
  assert.equal(MPP_ESCROW, "0x4d50500000000000000000000000000000000000");
  assert.equal(MPP_ACCESS_KEY_LIMIT, "5");
  assert.equal(MPP_MODEL_CHANNEL_LIMIT, "1");
  assert.equal(MPP_MIN_WALLET_BALANCE, "0.05");
  assert.deepEqual(MPP_ACCESS_KEY_SCOPES, [
    {
      address: USDC_E,
      recipients: [MPP_ESCROW, "0xdec0000000000000000000000000000000000000"],
      selector: "0x095ea7b3",
    },
    { address: USDC_E, selector: "0x95777d59" },
    {
      address: PATH_USD,
      recipients: [MPP_ESCROW, "0xdec0000000000000000000000000000000000000"],
      selector: "0x095ea7b3",
    },
    { address: PATH_USD, selector: "0x95777d59" },
    { address: "0xdec0000000000000000000000000000000000000", selector: "0xf0122b75" },
    { address: MPP_ESCROW },
  ]);
});
