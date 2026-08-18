import { DurableObject } from "cloudflare:workers";
import {
  ChatGptSubscription,
  subscriptionRevision,
  type ChatGptCredential,
  type ChatGptCredentialSeed,
  type ChatGptSubscriptionHandle,
  type ChatGptSubscriptionStore,
  type SubscriptionCommitRequest,
  type SubscriptionStoredValue,
} from "nanocodex/browser";

import nanocodexWasm from "./nanocodex.wasm";

export interface SubscriptionAuthEnv {
  CHATGPT_ACCESS_TOKEN?: string;
  CHATGPT_ACCOUNT_ID?: string;
  CHATGPT_FEDRAMP?: string;
  CHATGPT_REFRESH_TOKEN?: string;
  CHATGPT_ISSUER?: string;
}

export type SubscriptionSnapshot = {
  bearerToken: string;
  accountId: string;
  fedramp: boolean;
  revision: string;
};

type StoredValue = {
  revision: string;
  payload: string;
};

export class NanocodexSubscriptionAuth extends DurableObject<SubscriptionAuthEnv> {
  readonly #store: DurableObjectSubscriptionStore;
  #subscription?: Promise<ChatGptSubscriptionHandle>;

  constructor(ctx: DurableObjectState, env: SubscriptionAuthEnv) {
    super(ctx, env);
    this.#store = new DurableObjectSubscriptionStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/start") {
        return Response.json(await (await this.#manager()).startLogin(), { headers: noStore() });
      }
      if (request.method === "POST" && url.pathname === "/snapshot") {
        return Response.json(toSnapshot(await (await this.#manager()).credential()), {
          headers: noStore(),
        });
      }
      if (request.method === "POST" && url.pathname === "/recover") {
        const body = await request.json<{ revision?: unknown }>();
        if (typeof body.revision !== "string" || !/^(0|[1-9][0-9]*)$/.test(body.revision)) {
          return Response.json({ error: "invalid revision" }, { status: 400, headers: noStore() });
        }
        const credential = await (await this.#manager()).recover(subscriptionRevision(body.revision));
        return Response.json(toSnapshot(credential), { headers: noStore() });
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return Response.json(await (await this.#manager()).status(), { headers: noStore() });
      }
      if (request.method === "DELETE" && url.pathname === "/credentials") {
        await (await this.#manager()).logout();
        return new Response(null, { status: 204, headers: noStore() });
      }
      return Response.json({ error: "not_found" }, { status: 404, headers: noStore() });
    } catch (error) {
      return Response.json({ error: safeError(error) }, { status: 503, headers: noStore() });
    }
  }

  #manager(): Promise<ChatGptSubscriptionHandle> {
    if (this.#subscription) return this.#subscription;
    const seed = credentialSeed(this.env);
    this.#subscription = ChatGptSubscription.open({
      id: "cloudflare:subscription",
      store: this.#store,
      module: nanocodexWasm,
      ...(seed === undefined ? {} : { seed }),
      ...(this.env.CHATGPT_ISSUER?.trim() ? { issuer: this.env.CHATGPT_ISSUER.trim() } : {}),
    });
    return this.#subscription;
  }
}

class DurableObjectSubscriptionStore implements ChatGptSubscriptionStore {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async load(_id: string): Promise<SubscriptionStoredValue> {
    const stored = await this.#storage.get<StoredValue>("subscription");
    return stored
      ? { revision: subscriptionRevision(stored.revision), payload: stored.payload }
      : { revision: subscriptionRevision(0n) };
  }

  compareAndSwap(_id: string, request: SubscriptionCommitRequest) {
    return this.#storage.transaction(async (transaction) => {
      const current = await transaction.get<StoredValue>("subscription");
      const actualRevision = subscriptionRevision(current?.revision ?? "0");
      if (actualRevision !== request.expectedRevision) {
        return { status: "conflict" as const, actualRevision };
      }
      const revision = subscriptionRevision(BigInt(actualRevision) + 1n);
      await transaction.put("subscription", { revision, payload: request.payload });
      return { status: "committed" as const, revision };
    });
  }
}

function credentialSeed(env: SubscriptionAuthEnv): ChatGptCredentialSeed | undefined {
  const accessToken = env.CHATGPT_ACCESS_TOKEN?.trim();
  const accountId = env.CHATGPT_ACCOUNT_ID?.trim();
  if (!accessToken && !accountId) return undefined;
  if (!accessToken) throw new Error("CHATGPT_ACCESS_TOKEN is not configured");
  if (!accountId) throw new Error("CHATGPT_ACCOUNT_ID is not configured");
  return {
    accessToken,
    accountId,
    refreshToken: env.CHATGPT_REFRESH_TOKEN?.trim() || undefined,
    fedramp: env.CHATGPT_FEDRAMP === "true",
  };
}

function toSnapshot(credential: ChatGptCredential): SubscriptionSnapshot {
  return {
    bearerToken: credential.accessToken,
    accountId: credential.accountId,
    fedramp: credential.fedramp,
    revision: credential.revision,
  };
}

function noStore() {
  return { "cache-control": "no-store" };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
