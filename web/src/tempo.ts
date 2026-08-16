import { Provider, Storage } from "accounts";
import { createJsonChannelStore } from "mppx/client";
import { createTempoProviderFromAccounts } from "nanocodex/browser";
import type { Address } from "viem";

import {
  MPP_ACCESS_KEY_LIMIT,
  MPP_RESPONSES_WEBSOCKET_URL,
  TEMPO_ACCOUNT_STORAGE_KEY,
  USDC_E,
} from "./tempo-policy";
import { tempoAccessKeyKeystores } from "./tempo-keystore";

const ACCESS_KEY_PERSISTENCE_TIMEOUT_MS = 5_000;
const ACCESS_KEY_REHYDRATE_INTERVAL_MS = 50;

export async function createTempoMppSession(
  rootAddress: Address,
  accessKeyAddress: Address,
) {
  const provider = Provider.create({
    accessKey: { keystores: tempoAccessKeyKeystores() },
    mpp: false,
    storage: Storage.idb({ key: TEMPO_ACCOUNT_STORAGE_KEY }),
  });
  const persistedStore = provider.store as unknown as {
    persist: { rehydrate(): Promise<void> | void };
  };
  await (async () => {
    const deadline = Date.now() + ACCESS_KEY_PERSISTENCE_TIMEOUT_MS;
    let accountAvailable = false;
    do {
      await persistedStore.persist.rehydrate();
      const accounts = await provider.request({ method: "eth_accounts" });
      accountAvailable = accounts.some(
        (address) => address.toLowerCase() === rootAddress.toLowerCase(),
      );
      if (accountAvailable) {
        const client = provider.getClient();
        const account = await provider.getMppxParameters({ accessKey: accessKeyAddress }).resolveAccount({
          account: provider.getAccount({ address: rootAddress }),
          chainId: client.chain.id,
          operation: { kind: "authorizePaymentChannel" },
        });
        if (account) return;
      }
      await delay(ACCESS_KEY_REHYDRATE_INTERVAL_MS);
    } while (Date.now() < deadline);

    if (!accountAvailable) {
      throw new Error("Tempo Accounts state is unavailable in the Agent Worker");
    }
    throw new Error(`Tempo Accounts could not load MPP access key ${accessKeyAddress}`);
  })();
  const storage = Storage.idb({ key: "nanocodex-mpp-channels" });
  const storageScope = [
    rootAddress.toLowerCase(),
    new URL(MPP_RESPONSES_WEBSOCKET_URL).origin,
  ].join(":");
  const storageKey = (key: string) => `${storageScope}:${key}`;
  const channelStore = createJsonChannelStore({
    async get(key) { return (await storage.getItem<string>(storageKey(key))) ?? undefined; },
    async set(key, value) { await storage.setItem(storageKey(key), value); },
    async delete(key) { await storage.removeItem(storageKey(key)); },
  });
  const mcpChannels = new Map<string, bigint>();
  const tempoProvider = await createTempoProviderFromAccounts({
    wallet: provider,
    accessKey: accessKeyAddress as Address,
    policy: {
      autoSwap: { tokenIn: [USDC_E], slippage: 1 },
      channelStore,
      maxDeposit: MPP_ACCESS_KEY_LIMIT,
    },
    session: { bootstrap: true },
    mercator: {
      onChannelUpdate(entry) {
        mcpChannels.set(entry.channelId, entry.cumulativeAmount);
      },
    },
  });
  return {
    mpp: tempoProvider.session,
    provider: tempoProvider,
    mcpCumulative() {
      return [...mcpChannels.values()].reduce((total, amount) => total + amount, 0n);
    },
    rootAddress,
    accessKeyAddress() {
      return accessKeyAddress;
    },
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
