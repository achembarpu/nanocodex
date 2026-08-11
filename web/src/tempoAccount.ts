import { dialog, Expiry, Provider, Storage } from "accounts";
import { parseUnits, type Address } from "viem";

import {
  MPP_ACCESS_KEY_SCOPES,
  MPP_ACCESS_KEY_LIMIT,
  MPP_PAYMENT_TOKENS,
  USDC_E,
} from "./tempo-policy";

const accessKeyLimits = MPP_PAYMENT_TOKENS.map((token) => ({
  limit: parseUnits(MPP_ACCESS_KEY_LIMIT, 6),
  token,
}));

// The live OpenAI MPP challenge is denominated in USDC.e. The key can approve
// that token and operate its one payment-channel escrow, and nothing else.
const accessKeyScopes = MPP_ACCESS_KEY_SCOPES satisfies readonly {
  address: Address;
  recipients?: readonly Address[];
  selector?: string;
}[];

/**
 * The browser account authority for the website.
 *
 * Accounts owns the hosted login, managed access key, authorization policy,
 * and durable IndexedDB state. The Agent Worker opens the same storage with
 * the same SDK package when it needs to sign an MPP session.
 */
export const tempoAccount = Provider.create({
  adapter: dialog(),
  accessKey: {
    authorize: () => ({
      expiry: Expiry.days(1),
      limits: accessKeyLimits,
      scopes: accessKeyScopes,
      reuse: {
        minExpiry: Expiry.hours(1),
        minLimits: accessKeyLimits,
      },
      showDeposit: { amount: MPP_ACCESS_KEY_LIMIT, token: USDC_E },
    }),
  },
  mpp: false,
  storage: Storage.idb(),
});
