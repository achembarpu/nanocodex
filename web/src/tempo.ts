import { Provider, Storage } from "accounts";
import { createJsonChannelStore, tempo } from "mppx/client";
import { createTempoProvider } from "nanocodex/browser";
import type { Address } from "viem";

import {
  MPP_ACCESS_KEY_LIMIT,
  MPP_RESPONSES_WEBSOCKET_URL,
  USDC_E,
} from "./tempo-policy";

export async function createTempoMppSession(rootAddress: Address) {
  const provider = Provider.create({ mpp: false, storage: Storage.idb() });
  const accounts = await provider.request({ method: "eth_accounts" });
  if (!accounts.some((address) => address.toLowerCase() === rootAddress.toLowerCase())) {
    throw new Error("Tempo Accounts state is unavailable in the Agent Worker");
  }
  const client = provider.getClient();
  const mppxParameters = provider.getMppxParameters();
  const account = await mppxParameters.resolveAccount({
    account: provider.getAccount({ address: rootAddress }),
    chainId: client.chain.id,
    operation: { kind: "authorizePaymentChannel" },
  });
  if (!account) {
    throw new Error("Tempo Accounts has no locally signable MPP access key");
  }
  const accessKeyAddress = "accessKeyAddress" in account
    && typeof account.accessKeyAddress === "string"
    ? account.accessKeyAddress
    : undefined;
  if (!accessKeyAddress) {
    throw new Error("Tempo Accounts selected the root wallet instead of an MPP access key");
  }
  const accessKeyParameters = provider.getMppxParameters({
    accessKey: accessKeyAddress as Address,
  });

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
  const mpp = tempo.session.manager({
    ...accessKeyParameters,
    autoSwap: { tokenIn: [USDC_E], slippage: 1 },
    bootstrap: true,
    channelStore,
    maxDeposit: MPP_ACCESS_KEY_LIMIT,
  });
  const mcpChannels = new Map<string, bigint>();
  const mcpMethod = tempo({
    ...accessKeyParameters,
    autoSwap: { tokenIn: [USDC_E], slippage: 1 },
    channelStore,
    maxDeposit: MPP_ACCESS_KEY_LIMIT,
    onChannelUpdate(entry) {
      mcpChannels.set(entry.channelId, entry.cumulativeAmount);
    },
  });
  return {
    mpp,
    provider: createTempoProvider({
      session: mpp,
      payment: { methods: [mcpMethod] },
    }),
    mcpCumulative() {
      return [...mcpChannels.values()].reduce((total, amount) => total + amount, 0n);
    },
    rootAddress,
    accessKeyAddress() {
      return accessKeyAddress;
    },
  };
}
