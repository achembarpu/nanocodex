import { Expiry, Provider, Storage, Store, tempoWallet } from "accounts";
import { numberToHex, parseUnits, type Address } from "viem";

import {
  MPP_ACCESS_KEY_SCOPES,
  MPP_ACCESS_KEY_LIMIT,
  MPP_PAYMENT_TOKENS,
  TEMPO_ACCOUNT_STORAGE_KEY,
  USDC_E,
} from "./tempo-policy";
import { tempoAccessKeyKeystores } from "./tempo-keystore";

const accessKeyLimits = MPP_PAYMENT_TOKENS.map((token) => ({
  limit: parseUnits(MPP_ACCESS_KEY_LIMIT, 6),
  token,
}));

// The key can pay USDC.e or pathUSD Charge and Session challenges. Its only
// additional authority is the exact DEX swap needed to bridge those currencies.
const accessKeyScopes = MPP_ACCESS_KEY_SCOPES satisfies readonly {
  address: Address;
  recipients?: readonly Address[];
  selector?: string;
}[];

function accessKeyAuthorization() {
  return {
    expiry: Expiry.days(1),
    keyType: "p256" as const,
    limits: [...accessKeyLimits],
    scopes: [...accessKeyScopes],
    showDeposit: { amount: MPP_ACCESS_KEY_LIMIT, token: USDC_E },
  };
}

/**
 * The browser account authority for the website.
 *
 * Accounts owns the hosted login, managed access key, authorization policy,
 * and durable IndexedDB state. The Agent Worker opens the same storage with
 * the same SDK package when it needs to sign an MPP session.
 */
export const tempoAccount = Provider.create({
  adapter: tempoWallet(),
  accessKey: {
    authorize: () => ({
      ...accessKeyAuthorization(),
      reuse: {
        minExpiry: Expiry.hours(1),
        minLimits: accessKeyLimits,
      },
    }),
    keystores: tempoAccessKeyKeystores(),
  },
  mpp: false,
  storage: Storage.idb({ key: TEMPO_ACCOUNT_STORAGE_KEY }),
});

/** Wait for the persisted account and access keys before reading provider state. */
export async function rehydrateTempoAccount() {
  await Store.waitForHydration(tempoAccount.store);
}

export async function resolveTempoMppAccessKey(
  rootAddress: Address,
  accessKeyAddress?: Address,
) {
  const client = tempoAccount.getClient();
  const account = await tempoAccount.getMppxParameters(
    accessKeyAddress ? { accessKey: accessKeyAddress } : undefined,
  ).resolveAccount({
    account: tempoAccount.getAccount({ address: rootAddress }),
    chainId: client.chain.id,
    operation: { kind: "authorizePaymentChannel" },
  });
  const address = account && "accessKeyAddress" in account
    && typeof account.accessKeyAddress === "string"
    ? account.accessKeyAddress
    : undefined;
  return address as Address | undefined;
}

export async function ensureTempoMppAccessKey(
  rootAddress: Address,
  preferredAccessKey?: Address,
) {
  const existing = await resolveTempoMppAccessKey(rootAddress, preferredAccessKey);
  if (existing) return existing;

  const result = await tempoAccount.request({
    method: "wallet_authorizeAccessKey",
    params: [{
      ...accessKeyAuthorization(),
      limits: accessKeyLimits.map((limit) => ({
        ...limit,
        limit: numberToHex(limit.limit),
      })),
    }],
  });
  const accessKeyAddress = result.keyAuthorization.address as Address;
  const account = await tempoAccount.getMppxParameters({
    accessKey: accessKeyAddress,
  }).resolveAccount({
    account: tempoAccount.getAccount({ address: rootAddress }),
    chainId: tempoAccount.getClient().chain.id,
    operation: { kind: "authorizePaymentChannel" },
  });
  if (!account) {
    throw new Error("Tempo Accounts authorized an MPP key that cannot sign locally");
  }
  return accessKeyAddress;
}
