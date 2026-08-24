import { describe, expect, it } from "vitest";

import { ensureAccount, type AccountAuthEnv } from "../src/account-auth";

const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("account provisioning", () => {
  it("accepts a matching persistent account after a create conflict", async () => {
    const requests: string[] = [];
    const env = accountEnv(async (request) => {
      requests.push(request.method);
      return request.method === "PUT"
        ? new Response(null, { status: 409 })
        : Response.json(account(USER_ID, true));
    });

    await expect(ensureAccount(env, USER_ID, true)).resolves.toBeUndefined();
    expect(requests).toEqual(["PUT", "GET"]);
  });

  it("rejects a conflict owned by another account", async () => {
    const env = accountEnv(async (request) => request.method === "PUT"
      ? new Response(null, { status: 409 })
      : Response.json(account("22222222-2222-4222-8222-222222222222", true)));

    await expect(ensureAccount(env, USER_ID, true)).rejects.toThrow("account provisioning failed");
  });

  it("does not promote an anonymous account without a successful write", async () => {
    const env = accountEnv(async (request) => request.method === "PUT"
      ? new Response(null, { status: 409 })
      : Response.json(account(USER_ID, false)));

    await expect(ensureAccount(env, USER_ID, true)).rejects.toThrow("account provisioning failed");
  });
});

function accountEnv(fetch: (request: Request) => Promise<Response>): AccountAuthEnv {
  return {
    NANOCODEX_USERS: {
      getByName() {
        return {
          fetch(input: RequestInfo | URL, init?: RequestInit) {
            return fetch(new Request(input, init));
          },
        };
      },
    },
  } as unknown as AccountAuthEnv;
}

function account(id: string, persistent: boolean) {
  return {
    id,
    persistent,
    createdAt: 1,
    lastAuthenticatedAt: 1,
  };
}
