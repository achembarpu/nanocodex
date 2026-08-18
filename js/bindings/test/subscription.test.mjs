import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryChatGptSubscriptionStore,
  subscriptionRevision,
} from "../index.mjs";
import { ChatGptSubscription } from "../node/index.mjs";
import { load, openSubscription } from "../runtime/chatgpt-subscription.mjs";

test("Rust owns hosted ChatGPT credential state over a generic store", async () => {
  const id = "subscription-1";
  const store = createMemoryChatGptSubscriptionStore(id);
  const expiresAt = (Math.floor(Date.now() / 1_000) + 3_600) * 1_000;
  const subscription = await ChatGptSubscription.open({
    id,
    store,
    seed: {
      accessToken: jwt(expiresAt / 1_000),
      refreshToken: "refresh-secret",
      accountId: "account-1",
      fedramp: true,
    },
  });

  assert.deepEqual(await subscription.status(), {
    state: "authenticated",
    accountId: "account-1",
    expiresAt,
  });
  const persisted = store.snapshot();
  assert.equal(persisted.revision, subscriptionRevision(1n));
  assert.match(persisted.payload, /refresh-secret/);

  await subscription.logout();
  assert.deepEqual(await subscription.status(), { state: "signed_out" });
  subscription.dispose();
});

test("memory subscription store rejects stale compare-and-swap writes", () => {
  const store = createMemoryChatGptSubscriptionStore("subscription-2");
  assert.deepEqual(store.compareAndSwap("subscription-2", {
    expectedRevision: subscriptionRevision(0n),
    payload: "first",
  }), { status: "committed", revision: subscriptionRevision(1n) });
  assert.deepEqual(store.compareAndSwap("subscription-2", {
    expectedRevision: subscriptionRevision(0n),
    payload: "stale",
  }), { status: "conflict", actualRevision: subscriptionRevision(1n) });
  assert.equal(store.snapshot().payload, "first");
});

test("Worker subscription hosts can rebind after their Durable Object is reconstructed", async () => {
  const raw = () => ({
    async startLogin() { return JSON.stringify({ state: "signed_out" }); },
    async status() { return JSON.stringify({ state: "signed_out" }); },
    async credential() { throw new Error("not authenticated"); },
    async recover() { throw new Error("not authenticated"); },
    async logout() {},
    free() {},
  });
  const first = await openSubscription({
    id: "durable-subscription",
    store: createMemoryChatGptSubscriptionStore("durable-subscription", { payload: "first" }),
  }, raw, { replaceHost: true });
  const second = await openSubscription({
    id: "durable-subscription",
    store: createMemoryChatGptSubscriptionStore("durable-subscription", { payload: "second" }),
  }, raw, { replaceHost: true });

  assert.equal(JSON.parse(await load("durable-subscription")).payload, "second");
  first.dispose();
  assert.equal(JSON.parse(await load("durable-subscription")).payload, "second");
  second.dispose();
});

function jwt(exp) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp })}.`;
}
