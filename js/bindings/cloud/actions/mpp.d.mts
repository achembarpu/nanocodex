import type { Client } from "../Client.mjs";
import type { Hex, MppCharge } from "../types.mjs";

export declare namespace charge {
  type Options = Readonly<{
    grantId: Hex;
    amount: bigint;
    origin: string;
    memo?: string | undefined;
    signal?: AbortSignal | undefined;
  }>;
  type ReturnType = Promise<MppCharge>;
  type ErrorType = Error;
}

export function charge(client: Client, options: charge.Options): charge.ReturnType;
