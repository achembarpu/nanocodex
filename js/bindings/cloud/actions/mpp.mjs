import { chargeResultFromWire } from "../internal.mjs";

export async function charge(client, options) {
  if (!options?.grantId) throw new TypeError("charge requires grantId");
  if (typeof options.amount !== "bigint" || options.amount <= 0n) {
    throw new TypeError("charge requires a positive bigint amount");
  }
  const origin = new URL(options.origin).origin;
  return chargeResultFromWire(await client.request({
    method: "POST",
    path: `/v1/grants/${options.grantId}/mpp/charge`,
    body: {
      amount_atomics: String(options.amount),
      origin,
      memo: options.memo,
    },
    signal: options.signal,
  }), client);
}
