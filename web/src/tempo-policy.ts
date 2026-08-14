import { Addresses, Scopes, Selectors } from "viem/tempo";

import {
  MPP_ESCROW,
  PATH_USD,
  USDC_E,
} from "./tempo-constants.ts";

export * from "./tempo-constants.ts";
const usdc = Scopes.tip20(USDC_E);
const pathUsd = Scopes.tip20(PATH_USD);
export const MPP_ACCESS_KEY_SCOPES = [
  usdc.approve({ recipients: [MPP_ESCROW, Addresses.stablecoinDex] }),
  usdc.transferWithMemo(),
  pathUsd.approve({ recipients: [MPP_ESCROW, Addresses.stablecoinDex] }),
  pathUsd.transferWithMemo(),
  Scopes.contract(Addresses.stablecoinDex, Selectors.stablecoinDex).swapExactAmountOut(),
  Scopes.target(MPP_ESCROW).any(),
] as const;
