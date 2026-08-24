import assert from "node:assert/strict";
import { test } from "node:test";

import { Actions, Client, Dialog, Errors, Transport } from "../cloud/index.mjs";
import { projectAgentObservations } from "../cloud/actions/agent.mjs";
import { connectionFromWire } from "../cloud/internal.mjs";

test("Connect opens its grant-provisioned durable agent without a redundant state probe", async () => {
  const requests = [];
  const agentId = "019fc927-b280-79a7-8445-1b9996ad2fb0";
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  const client = Client.create({
    appId: "durable-workspace",
    dialog: Dialog.memory(),
    provider: { request() { throw new Error("wallet should not be used"); } },
    transport: Transport.from({
      key: "durable",
      name: "durable",
      type: "durable",
      setup() {
        return {
          baseUrl: "https://connect.example",
          async fetch(input, init) {
            const request = new Request(input, init);
            requests.push(request);
            return Response.json({ agent_id: agentId, session_id: agentId });
          },
          async request() { throw new Error("control-plane request was unexpected"); },
        };
      },
    }),
  });
  client._setSessionToken("grant-session-test");
  const connection = connectionFromWire(testConnectionWire({
    agentId,
    expiry,
    keyId: "0x1111111111111111111111111111111111111111",
    capabilities: ["nanocodex.agent", "agent.output.final", "chatgpt"],
  }));
  const agent = await client.agent.create({ connection });

  assert.equal(agent.id, agentId);
  assert.equal(agent.type, "connect");
  assert.equal(requests.length, 0);
  await assert.rejects(
    client.agent.create({ connection, sessionId: "browser-local" }),
    /do not accept app-local sessionId/,
  );
});

test("Connect binds normalized cloud accounts into auth resources and the connection request", async () => {
  const requests = [];
  const fetches = [];
  const walletRequests = [];
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  const keyId = "0x1111111111111111111111111111111111111111";
  const client = Client.create({
    appId: "connector-workspace",
    dialog: Dialog.memory(),
    provider: {
      async request(request) {
        walletRequests.push(request);
        return {
          accounts: [{
            address: "0x8ba1f109551bd432803012645ac136ddd64dba72",
            capabilities: {
              auth: { approval_id: "approval-test" },
              keyAuthorization: {
                address: keyId,
                keyId,
                keyType: "p256",
                chainId: 4217n,
                expiry,
                witness: `0x${"22".repeat(32)}`,
              },
              personalSign: { keyAuthorization: "0x1234" },
            },
          }],
        };
      },
    },
    transport: Transport.from({
      key: "capture",
      name: "capture",
      type: "capture",
      setup() {
        return {
          baseUrl: "https://connect.example",
          async fetch(input, init) {
            const request = new Request(input, init);
            fetches.push(request);
            return Response.json({ ok: true });
          },
          async request(request) {
            requests.push(request);
            return testConnectionWire({ expiry, keyId, capabilities: [
              "nanocodex.agent",
              "agent.output.final",
              "agent.output.actions",
              "agent.history.read",
              "agent.trace.read",
              "github",
              "gdrive",
            ] });
          },
        };
      },
    }),
  });

  const connection = await client.connection.connect({
    capabilities: {
      auth: {
        challenge: "https://connect.example/v1/connect/auth/challenge",
        verify: "https://connect.example/v1/connect/auth",
        logout: "https://connect.example/v1/connect/auth/logout",
        resources: [
          "urn:example:configured",
          "urn:nanocodex:app:connector-workspace",
          "urn:nanocodex:connector:github",
        ],
      },
      cloudAccounts: {
        github: true,
        gmail: false,
        gdrive: true,
        chatgpt: "true",
        unknown: true,
      },
      agent: {
        finalMessages: false,
        actionSummaries: false,
        conversationHistory: false,
        rawTraces: true,
      },
    },
  });

  assert.deepEqual(walletRequests, [{
    method: "wallet_connect",
    params: [{
      chainId: "0x1079",
      capabilities: {
        auth: {
          challenge: "https://connect.example/v1/connect/auth/challenge",
          logout: "https://connect.example/v1/connect/auth/logout",
          resources: [
            "urn:example:configured",
            "urn:nanocodex:app:connector-workspace",
            "urn:nanocodex:connectors:github,gdrive",
            "urn:nanocodex:agent:visibility:reply,actions,history,traces",
          ],
        },
      },
    }],
  }]);
  assert.deepEqual(requests[0].body.requested_connectors, ["github", "gdrive"]);
  assert.equal("agent" in requests[0].body, false);
  assert.equal("visibility" in requests[0].body, false);
  assert.equal(requests[0].body.approval_id, "approval-test");
  assert.equal(requests[0].headers, undefined);
  assert.deepEqual(connection.grant.connectors, ["github", "gdrive"]);
  assert.deepEqual(connection.grant.visibility, {
    finalMessages: true,
    actionSummaries: true,
    conversationHistory: true,
    rawTraces: true,
  });
  assert.equal("credentials" in connection.grant, false);
  assert.equal("account" in connection.grant, false);

  await client.fetch("/v1/agent/account-info", { headers: { accept: "application/json" } });
  assert.equal(fetches[0].url, "https://connect.example/v1/agent/account-info");
  assert.equal(fetches[0].headers.get("authorization"), "Bearer grant-session-test");
  const captured = client._captureSession();
  client._setSessionToken("replacement-grant-session");
  await captured.fetch("/v1/egress");
  assert.equal(fetches[1].headers.get("authorization"), "Bearer grant-session-test");
  assert.equal(fetches[1].headers.get("authorization")?.includes("replacement"), false);
  await assert.rejects(
    Promise.resolve().then(() => client.fetch("https://evil.example/steal")),
    /restricted to its configured API origin/,
  );
});

test("Connect reselects a reusable access key when the passkey account changes", async () => {
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  const initialAccount = "0x1111111111111111111111111111111111111111";
  const selectedAccount = "0x2222222222222222222222222222222222222222";
  const initialKey = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const selectedKey = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const requests = [];
  const walletRequests = [];
  const provider = {
    store: {
      getState() {
        return {
          accounts: [{ address: initialAccount }],
          activeAccount: 0,
          accessKeys: [
            { access: initialAccount, address: initialKey, chainId: 4217, expiry },
            { access: selectedAccount, address: selectedKey, chainId: 4217, expiry },
          ],
        };
      },
    },
    async request(request) {
      walletRequests.push(request);
      return {
        accounts: [{
          address: selectedAccount,
          capabilities: { auth: { approval_id: "approval-selected" } },
        }],
      };
    },
  };
  const client = Client.create({
    appId: "account-switch-workspace",
    dialog: Dialog.memory(),
    provider,
    transport: Transport.from({
      key: "account-switch",
      name: "account-switch",
      type: "account-switch",
      setup() {
        return {
          baseUrl: "https://connect.example",
          async fetch() {
            return Response.json({ ok: true });
          },
          async request(request) {
            requests.push(request);
            if (request.method === "GET") return { registered: true };
            return {
              ...testConnectionWire({ expiry, keyId: selectedKey, capabilities: ["nanocodex.agent"] }),
              account_address: selectedAccount,
            };
          },
        };
      },
    }),
  });

  await client.connection.connect();

  assert.equal("authorizeAccessKey" in walletRequests[0].params[0].capabilities, false);
  assert.deepEqual(
    requests.filter((request) => request.method === "GET").map((request) => request.path),
    [
      `/v1/access-keys/${initialAccount}/${initialKey}`,
      `/v1/access-keys/${selectedAccount}/${selectedKey}`,
    ],
  );
  assert.deepEqual(requests.at(-1).body.reuse_access_key, {
    key_id: selectedKey,
    expiry,
  });
});

test("Connect persists, validates, and clears an app-scoped grant session", async () => {
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  const keyId = "0x1111111111111111111111111111111111111111";
  const storage = memoryStorage();
  const requests = [];
  const wire = testConnectionWire({
    expiry,
    keyId,
    capabilities: ["nanocodex.agent", "agent.output.final", "chatgpt"],
  });
  const transport = Transport.from({
    key: "session",
    name: "session",
    type: "session",
    setup() {
      return {
        baseUrl: "https://connect.example",
        async request(request) {
          requests.push(request);
          if (request.method === "POST" && request.path === "/v1/connections") return wire;
          if (request.method === "GET" && request.path === `/v1/grants/${wire.grant.id}`) return wire;
          if (request.method === "POST" && request.path === "/v1/connections/disconnect") return undefined;
          throw new Error(`unexpected request ${request.method} ${request.path}`);
        },
      };
    },
  });
  const provider = {
    async request() {
      return {
        accounts: [{
          address: wire.account_address,
          capabilities: {
            auth: { approval_id: "approval-session" },
            keyAuthorization: {
              address: keyId,
              keyId,
              keyType: "p256",
              chainId: 4217n,
              expiry,
              witness: wire.access_key.witness,
            },
            personalSign: { keyAuthorization: "0x1234" },
          },
        }],
      };
    },
  };
  const first = Client.create({
    appId: "session-workspace",
    dialog: Dialog.memory(),
    provider,
    session: storage,
    transport,
  });
  const connected = await first.connection.connect();
  assert.equal(connected.grant.id, wire.grant.id);
  const { grant_token: _grantToken, ...connectionWire } = wire;
  assert.deepEqual(JSON.parse(storage.getItem("nanocodex:connect:session-workspace:session")), {
    grantId: wire.grant.id,
    token: wire.grant_token,
    connection: connectionWire,
  });

  const restoredClient = Client.create({
    appId: "session-workspace",
    dialog: Dialog.memory(),
    provider: {
      request() { throw new Error("wallet must not reopen"); },
    },
    session: storage,
    transport,
  });
  assert.equal(restoredClient._resumeConnection().agentId, wire.agent_id);
  const restored = await restoredClient.connection.reconnect();
  assert.equal(restored.grant.id, connected.grant.id);
  assert.equal(requests.at(-1).headers.authorization, `Bearer ${wire.grant_token}`);

  await restoredClient.connection.disconnect();
  assert.equal(storage.getItem("nanocodex:connect:session-workspace:session"), null);
  assert.equal(restoredClient._hasSession(), false);
});

test("Connect account logout clears the local session without revoking the app grant", async () => {
  const storage = memoryStorage();
  const walletRequests = [];
  const client = Client.create({
    appId: "logout-workspace",
    dialog: Dialog.memory(),
    provider: {
      async request(request) {
        walletRequests.push(request);
      },
    },
    session: storage,
    transport: Transport.from({
      key: "logout",
      name: "logout",
      type: "logout",
      setup() {
        return {
          baseUrl: "https://connect.example",
          async fetch() { throw new Error("unused"); },
          async request() { throw new Error("grant transport must not be called"); },
        };
      },
    }),
  });
  client._setSession({
    grantId: `0x${"12".repeat(32)}`,
    token: "grant-session",
  });

  await client.account.logout();
  assert.equal(client._hasSession(), false);
  assert.deepEqual(walletRequests, [{ method: "wallet_disconnect" }]);
});

test("Connect account logout clears the local session when wallet logout fails", async () => {
  const storage = memoryStorage();
  const client = Client.create({
    appId: "failed-logout-workspace",
    dialog: Dialog.memory(),
    provider: {
      async request(request) {
        assert.equal(request.method, "wallet_disconnect");
        throw new Error("account service unavailable");
      },
    },
    session: storage,
    transport: Transport.mock(),
  });
  client._setSession({
    grantId: `0x${"34".repeat(32)}`,
    token: "grant-session",
  });

  await assert.rejects(client.account.logout(), /account service unavailable/);
  assert.equal(client._hasSession(), false);
});

test("Nanocodex Connect signs one witness-bound access key and enforces its MPP permission", async () => {
  const expiry = Math.floor(Date.now() / 1_000) + 30 * 86_400;
  const keyId = "0x1111111111111111111111111111111111111111";
  const witness = `0x${"22".repeat(32)}`;
  const client = Client.create({
    appId: "test-workspace",
    dialog: Dialog.memory(),
    provider: {
      async request(request) {
        assert.equal(request.method, "wallet_connect");
        assert.deepEqual(request.params[0].capabilities.auth.resources, [
          "repositories",
          "model-entitlement",
          "urn:nanocodex:app:test-workspace",
          "urn:nanocodex:agent:visibility:reply,actions",
        ]);
        return {
          accounts: [{
            address: "0x8ba1f109551bd432803012645ac136ddd64dba72",
            capabilities: {
              auth: { approval_id: "approval-test" },
              keyAuthorization: {
                address: keyId,
                keyId,
                keyType: "p256",
                chainId: 4217n,
                expiry,
                witness,
              },
              personalSign: { keyAuthorization: "0x1234" },
            },
          }],
        };
      },
    },
    transport: Transport.mock({ appName: "Test Workspace" }),
  });

  let connection = await Actions.connection.connect(client, {
    capabilities: {
      auth: { resources: [
        "repositories",
        "model-entitlement",
        "urn:nanocodex:agent:trace:read",
      ] },
    },
  });
  assert.equal(connection.grant.status, "active");
  assert.deepEqual(connection.grant.visibility, {
    finalMessages: true,
    actionSummaries: true,
    conversationHistory: false,
    rawTraces: false,
  });
  assert.equal(connection.accessKey.keyId, keyId);
  assert.equal(connection.accessKey.witness, witness);
  assert.equal(connection.accessKey.authorization, "0x1234");
  assert.equal(connection.mpp.balance, 0n);
  assert.match(connection.agentId, /^agent_/);

  const funding = client.machineUsd.fund({
    accountAddress: connection.accountAddress,
    grantId: connection.grant.id,
    usdAmountCents: 500,
  });
  const fundingRequest = await nextDialogRequest(client.dialog);
  assert.equal(fundingRequest.type, "machineUsdFund");
  assert.equal(fundingRequest.usdAmountCents, 500);
  client.dialog.respond({
    order: {
      id: "ord_test",
      status: "complete",
      usd_amount_cents: 500,
      machine_usd_amount_atomics: "5000000",
      issuance_transaction_hash: `0x${"33".repeat(32)}`,
    },
  });
  connection = (await funding).connection;
  assert.equal(connection.mpp.balance, 0n);

  await assert.rejects(
    client.mpp.charge({
      amount: 300_000n,
      grantId: connection.grant.id,
      origin: "https://models.example",
    }),
    (error) => error instanceof Errors.HttpError
      && error.code === "mpp_request_limit_exceeded"
      && error.status === 403,
  );

  const revoked = await client.grant.revoke({ grantId: connection.grant.id });
  assert.equal(revoked.status, "revoked");
});

test("recognized visibility capabilities do not receive the legacy output fallback", () => {
  const expiry = Math.floor(Date.now() / 1_000) + 3_600;
  const keyId = "0x1111111111111111111111111111111111111111";
  const connection = connectionFromWire(testConnectionWire({
    expiry,
    keyId,
    capabilities: ["nanocodex.agent", "agent.history.read"],
  }));

  assert.deepEqual(connection.grant.visibility, {
    finalMessages: false,
    actionSummaries: false,
    conversationHistory: true,
    rawTraces: false,
  });
});

test("ConnectAgent projections hide terminal output outside the signed resources", async () => {
  assert.deepEqual(projectAgentObservations({
    finalMessages: false,
    actionSummaries: false,
  }, "secret final", ["tool.search"]), {
    finalMessage: "",
    capabilitiesUsed: [],
  });

});

async function nextDialogRequest(dialog) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const request = dialog.getRequest();
    if (request) return request;
    await Promise.resolve();
  }
  throw new Error("Nanocodex Connect did not open its dialog");
}

function testConnectionWire({ expiry, keyId, capabilities, agentId = "agent_connectors" }) {
  return {
    grant_token: "grant-session-test",
    account_address: "0x8ba1f109551bd432803012645ac136ddd64dba72",
    agent_id: agentId,
    grant: {
      id: `0x${"33".repeat(32)}`,
      permission: "agent.run",
      status: "active",
      expires_at: expiry,
      capabilities,
    },
    access_key: {
      address: keyId,
      chain_id: "4217",
      key_id: keyId,
      key_type: "p256",
      limits: [],
      scopes: [],
      witness: `0x${"22".repeat(32)}`,
      expiry,
      authorization: "0x1234",
    },
    mpp: {
      token: "0x20c0000000000000000000000000000000000001",
      symbol: "MACHUSD",
      settlement_token: "0x20C000000000000000000000b9537d11c60E8b50",
      settlement_symbol: "USDC.e",
      settlement_balance_atomics: "0",
      limit_atomics: "10000000",
      max_per_request_atomics: "250000",
      period: 86_400,
      balance_atomics: "0",
      spent_atomics: "0",
    },
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}
