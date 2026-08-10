export const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
export const MPP_ESCROW = "0x4d50500000000000000000000000000000000000";
export const MPP_ACCESS_KEY_LIMIT = "0.25";
export const MPP_MIN_WALLET_BALANCE = "0.05";
export const MPP_RESPONSES_WEBSOCKET_URL = "wss://openai.mpp.tempo.xyz/v1/responses";
export const MPP_PAYMENT_TOKENS = [USDC_E] as const;
export const MPP_ACCESS_KEY_SCOPES = [
  {
    address: USDC_E,
    recipients: [MPP_ESCROW],
    selector: "approve(address,uint256)",
  },
  { address: MPP_ESCROW },
] as const;
