import type { Transport } from "../../browser/Transport.mjs";
import type { Client } from "../Client.mjs";
import type { Connection } from "../types.mjs";

export declare namespace transport {
  type Options = Readonly<{ connection: Connection }>;
  type ReturnType = Transport;
  type ErrorType = Error;
}

/** Creates a local browser/WASM Responses transport backed by this Connect grant. */
export function transport(client: Client, options: transport.Options): transport.ReturnType;
