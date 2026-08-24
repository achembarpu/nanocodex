import type { ConnectActions } from "./Decorator.mjs";
import type { Instance as DialogInstance, Dialog } from "./Dialog.mjs";
import type { Request, Transport } from "./Transport.mjs";
import type { Auth, AuthorizeAccessKey } from "./actions/connection.mjs";
import type { Provider } from "accounts";

export type Base = Readonly<{
  appId: string;
  accessKey: Readonly<{ authorize?: AuthorizeAccessKey | undefined }> | undefined;
  auth: Auth | undefined;
  dialog: DialogInstance;
  key: string;
  name: string;
  provider: Provider.Provider;
  type: "connect";
  uid: string;
  transport: Readonly<{ key: string; name: string; type: string; baseUrl: string }>;
  fetch(input: RequestInfo | URL, init?: RequestInit | undefined): Promise<Response>;
  request(request: Request): Promise<unknown>;
}>;

export type Client<extension extends object = ConnectActions> = Base & extension & {
  extend<next extends object>(decorator: (client: Client<extension>) => next): Client<extension & next>;
};

export type Parameters = Readonly<{
  appId: string;
  /** Accounts-compatible default SIWE round-trip configuration. */
  auth?: Auth | undefined;
  /** Accounts-compatible default access-key authorization policy. */
  accessKey?: Readonly<{ authorize?: AuthorizeAccessKey | undefined }> | undefined;
  dialog?: Dialog | undefined;
  key?: string | undefined;
  name?: string | undefined;
  /** Advanced override for the Accounts provider that owns the access key. */
  provider?: Provider.Provider | undefined;
  transport?: Transport | undefined;
}>;

export function create(parameters: Parameters): Client;
