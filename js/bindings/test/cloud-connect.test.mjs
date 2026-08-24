import assert from "node:assert/strict";
import { test } from "node:test";

import { Actions, Client, Dialog, Errors, Transport } from "../cloud/index.mjs";
import {
  createGrantModelWebSocket,
  decimalAtomics,
} from "../cloud/actions/agent.mjs";
import { connectorRequestTools } from "../cloud/connectors.mjs";

test("MPP channel ceilings preserve the signed six-decimal daily limit", () => {
  assert.equal(decimalAtomics(10_000_000n, 6), "10");
  assert.equal(decimalAtomics(250_000n, 6), "0.25");
  assert.equal(decimalAtomics(1n, 6), "0.000001");
});

test("the default model uses a one-time grant ticket for the connected ChatGPT account", async () => {
  const requests = [];
  const sockets = [];
  class TestWebSocket {
    constructor(url) {
      sockets.push(String(url));
    }
  }
  const connection = { grant: { id: `0x${"ab".repeat(32)}` } };
  const socket = await createGrantModelWebSocket({
    transport: { baseUrl: "https://connect.example/" },
    async request(request) {
      requests.push(request);
      return { ticket: "model-ticket-once" };
    },
  }, connection, "session-123", { turnState: "turn-state-1" }, TestWebSocket);

  assert.ok(socket instanceof TestWebSocket);
  assert.deepEqual(requests, [{
    method: "POST",
    path: `/v1/grants/${connection.grant.id}/model/ticket`,
    body: { session_id: "session-123", turn_state: "turn-state-1" },
  }]);
  assert.deepEqual(sockets, [
    `wss://connect.example/v1/grants/${connection.grant.id}/model?session_id=session-123&ticket=model-ticket-once`,
  ]);
});

test("Connect binds normalized cloud accounts into auth resources and the connection request", async () => {
  const requests = [];
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
          async request(request) {
            requests.push(request);
            return testConnectionWire({ expiry, keyId, capabilities: [
              "nanocodex.agent",
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
            "urn:nanocodex:connector:github",
            "urn:nanocodex:connector:gdrive",
          ],
        },
      },
    }],
  }]);
  assert.deepEqual(requests[0].body.requested_connectors, ["github", "gdrive"]);
  assert.equal(requests[0].body.approval_id, "approval-test");
  assert.equal(requests[0].headers, undefined);
  assert.deepEqual(connection.grant.connectors, ["github", "gdrive"]);
  assert.equal("credentials" in connection.grant, false);
  assert.equal("account" in connection.grant, false);
});

test("connector_request is grant-scoped, abortable, accounted, and absent for ChatGPT-only grants", async () => {
  const requests = [];
  const calls = new Set();
  const controller = new AbortController();
  const connection = {
    grant: {
      id: `0x${"44".repeat(32)}`,
      connectors: Object.freeze(["github", "gmail"]),
    },
  };
  const tools = connectorRequestTools({
    async request(request) {
      requests.push(request);
      return { status: 200, headers: { "content-type": "application/json" }, body: "{\"login\":\"octocat\"}" };
    },
  }, connection, calls);

  assert.deepEqual(tools.connector_request.parameters.properties.provider.enum, ["github", "gmail"]);
  const result = await tools.connector_request.handler({
    provider: "github",
    path: "/user",
    method: "GET",
    headers: { accept: "application/vnd.github+json" },
  }, { signal: controller.signal });
  assert.deepEqual(requests, [{
    method: "POST",
    path: `/v1/grants/${connection.grant.id}/connectors/github/request`,
    body: {
      path: "/user",
      method: "GET",
      headers: { accept: "application/vnd.github+json" },
    },
    signal: controller.signal,
  }]);
  assert.deepEqual(result, {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "{\"login\":\"octocat\"}",
  });
  assert.deepEqual([...calls], ["connector_request"]);

  await assert.rejects(
    tools.connector_request.handler({ provider: "gdrive", path: "/files" }, { signal: controller.signal }),
    /provider is not present in the active grant/,
  );
  await assert.rejects(
    tools.connector_request.handler({ provider: "github", path: "/user", body: { leaked: true } }, { signal: controller.signal }),
    /body must be a string/,
  );
  assert.deepEqual(
    connectorRequestTools({ request() {} }, { grant: { connectors: ["chatgpt"] } }, new Set()),
    {},
  );
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
      auth: { resources: ["repositories", "model-entitlement"] },
    },
  });
  assert.equal(connection.grant.status, "active");
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

async function nextDialogRequest(dialog) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const request = dialog.getRequest();
    if (request) return request;
    await Promise.resolve();
  }
  throw new Error("Nanocodex Connect did not open its dialog");
}

function testConnectionWire({ expiry, keyId, capabilities }) {
  return {
    grant_token: "grant-session-test",
    account_address: "0x8ba1f109551bd432803012645ac136ddd64dba72",
    agent_id: "agent_connectors",
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
