import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MPP_ACCESS_KEY_LIMIT,
  MPP_ACCESS_KEY_SCOPES,
  MPP_ESCROW,
  MPP_MIN_WALLET_BALANCE,
  MPP_PAYMENT_TOKENS,
  USDC_E,
} from "../src/tempo-policy.ts";

test("MPP access-key policy is scoped to the live Responses currency and escrow", () => {
  assert.deepEqual(MPP_PAYMENT_TOKENS, [USDC_E]);
  assert.equal(USDC_E, "0x20c000000000000000000000b9537d11c60e8b50");
  assert.equal(MPP_ESCROW, "0x4d50500000000000000000000000000000000000");
  assert.equal(MPP_ACCESS_KEY_LIMIT, "0.25");
  assert.equal(MPP_MIN_WALLET_BALANCE, "0.05");
  assert.deepEqual(MPP_ACCESS_KEY_SCOPES, [
    {
      address: USDC_E,
      recipients: [MPP_ESCROW],
      selector: "approve(address,uint256)",
    },
    { address: MPP_ESCROW },
  ]);
});
