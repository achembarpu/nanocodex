import { describe, expect, it } from "vitest";

import { attachAgent, detachAgent, type AccountAuthEnv } from "../src/account-auth";
import { bindAgentCredential, unbindAgentCredential } from "../src/credentials";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "018f25e8-7b51-7a32-8c4d-0123456789ab";

describe("ownership I/O deadlines", () => {
  for (const operation of [
    {
      name: "credential binding",
      run: (fetcher: Fetcher) => bindAgentCredential(fetcher, "subject", USER_ID, 10),
    },
    {
      name: "credential unbinding",
      run: (fetcher: Fetcher) => unbindAgentCredential(fetcher, "subject", USER_ID, 10),
    },
    {
      name: "account attachment",
      run: (fetcher: Fetcher) => attachAgent(accountEnv(fetcher), USER_ID, AGENT_ID, 10),
    },
    {
      name: "account detachment",
      run: (fetcher: Fetcher) => detachAgent(accountEnv(fetcher), USER_ID, AGENT_ID, 10),
    },
  ]) {
    it(`bounds ${operation.name} through noncooperative body disposal`, async () => {
      const fetcher = {
        async fetch(): Promise<Response> {
          return new Response(noncooperativeBody(), { status: 200 });
        },
      } as unknown as Fetcher;

      await expect(within(operation.run(fetcher), operation.name)).rejects.toThrow(/timed out after 10ms/);
    });
  }

  it("does not let status validation bypass the response-disposal deadline", async () => {
    const fetcher = {
      async fetch(): Promise<Response> {
        return new Response(noncooperativeBody(), { status: 503 });
      },
    } as unknown as Fetcher;

    await expect(within(
      bindAgentCredential(fetcher, "subject", USER_ID, 10),
      "failed response disposal",
    )).rejects.toThrow(/timed out after 10ms/);
  });
});

function accountEnv(fetcher: Fetcher): AccountAuthEnv {
  return {
    NANOCODEX_USERS: {
      getByName() { return fetcher; },
    },
  } as unknown as AccountAuthEnv;
}

function noncooperativeBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    cancel() { return new Promise<void>(() => {}); },
  });
}

async function within<Result>(promise: Promise<Result>, operation: string): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} test timed out`)), 500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
