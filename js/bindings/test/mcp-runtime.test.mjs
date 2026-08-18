import assert from "node:assert/strict";
import { test } from "node:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { Challenge, Credential, Mcp, Method } from "mppx";
import { Methods } from "mppx/tempo";

import { createCodeRuntime } from "../runtime/code-runtime.mjs";
import { createMcpRuntime } from "../runtime/mcp-runtime.mjs";
import {
  createTempoProvider,
  createTempoProviderFromAccounts,
  DEFAULT_MERCATOR_MCP_URL,
  resolveMcpServers,
} from "../runtime/tempo-provider.mjs";

test("Mercator is a paid default only for explicit Tempo provider mode", () => {
  const session = { ws: async () => ({}) };
  const payment = { methods: [{}] };
  assert.throws(
    () => createTempoProvider({ session, payment: { methods: [] } }),
    /at least one MPPx method/,
  );
  const provider = createTempoProvider({ session, payment });

  assert.equal(resolveMcpServers(session, undefined), undefined);
  assert.equal(resolveMcpServers(undefined, undefined), undefined);
  assert.equal(resolveMcpServers(provider, false), undefined);
  assert.equal(provider.session, session);

  const defaults = resolveMcpServers(provider, undefined);
  assert.equal(defaults.mercator.url, DEFAULT_MERCATOR_MCP_URL);
  assert.equal(defaults.mercator.payment, payment);

  const custom = { client: { listTools() {}, callTool() {} } };
  assert.equal(resolveMcpServers(provider, { mercator: custom }).mercator, custom);
});

test("any Accounts SDK provider can own both Tempo payment paths", async () => {
  const accessKey = "0x0000000000000000000000000000000000000001";
  const calls = [];
  const walletParameters = {
    getClient() { return {}; },
    async resolveAccount() { return undefined; },
  };
  const wallet = {
    getMppxParameters(options) {
      calls.push(options);
      return walletParameters;
    },
  };

  const provider = await createTempoProviderFromAccounts({
    wallet,
    accessKey,
    policy: { maxDeposit: "0.05" },
    session: { bootstrap: true },
  });

  assert.deepEqual(calls, [{ accessKey }]);
  assert.equal(provider.kind, "tempo");
  assert.equal(typeof provider.ws, "function");
  const mercator = resolveMcpServers(provider, undefined).mercator;
  assert.equal(mercator.url, DEFAULT_MERCATOR_MCP_URL);
  assert.equal(mercator.payment.methods.length, 1);
  assert.equal(mercator.payment.methods[0].length, 2);

  await assert.rejects(
    createTempoProviderFromAccounts({ wallet: {} }),
    /getMppxParameters/,
  );
  await assert.rejects(
    createTempoProviderFromAccounts({
      wallet: { getMppxParameters: () => ({}) },
    }),
    /invalid MPPx parameters/,
  );
});

test("remote MCP stays deferred behind tool_search and executes through Code Mode", async () => {
  const calls = [];
  const client = {
    async listTools(params) {
      if (!params?.cursor) {
        return {
          tools: [{
            name: "search_endpoints",
            description: "Find curated external services.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          }],
          nextCursor: "paid",
        };
      }
      return {
        tools: [{
          name: "call",
          description: "Call a paid curated service.",
          inputSchema: {
            type: "object",
            properties: { service_id: { type: "string" } },
            required: ["service_id"],
          },
        }],
      };
    },
    async callTool(input) {
      calls.push(input);
      return { content: [{ type: "text", text: `called ${input.name}` }] };
    },
  };
  const mcp = await createMcpRuntime({
    mercator: {
      client,
      description: "Curated paid services through Mercator.",
    },
  });
  const runtime = createCodeRuntime();
  runtime.addProvider(mcp);

  const definitions = JSON.parse(runtime.toolDefinitions());
  assert.equal(definitions[0].type, "tool_search");
  assert.deepEqual(
    definitions.slice(1, 4).map((definition) => definition.name),
    ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"],
  );
  assert.deepEqual(
    definitions.slice(4).map((definition) => [definition.name, definition.defer_loading]),
    [
      ["mcp__mercator__call", true],
      ["mcp__mercator__search_endpoints", true],
    ],
  );

  const searched = JSON.parse(await runtime.executeTool(
    "tool_search",
    JSON.stringify({ query: "paid service" }),
  ));
  assert.equal(searched.success, true);
  assert.equal(searched.structured_result[0].name, "mcp__mercator__");
  assert.equal(searched.structured_result[0].tools[0].defer_loading, true);

  const execution = JSON.parse(await runtime.executeCode(
    `if ("tool_search" in tools || ALL_TOOLS.some((tool) => tool.type === "tool_search")) {
      throw new Error("tool_search must remain direct");
    }
    const result = await tools.mcp__mercator__call({ service_id: "exa" });
    text(result);`,
    "session-1",
    "exec-1",
  ));
  assert.equal(execution.success, true);
  assert.deepEqual(calls, [{ name: "call", arguments: { service_id: "exa" } }]);
  assert.equal(execution.nested_calls[0].name, "mcp__mercator__call");
  assert.match(JSON.stringify(execution.output), /called call/);
});

test("browser MCP exposes native-compatible resource listing and reads", async () => {
  const client = {
    async listTools() {
      return { tools: [] };
    },
    async listResources(params) {
      return params?.cursor
        ? { resources: [{ uri: "docs://two", name: "Two" }] }
        : { resources: [{ uri: "docs://one", name: "One" }], nextCursor: "next" };
    },
    async listResourceTemplates() {
      return { resourceTemplates: [{ uriTemplate: "docs://{slug}", name: "Docs" }] };
    },
    async readResource({ uri }) {
      return { contents: [{ uri, text: "resource body" }] };
    },
  };
  const mcp = await createMcpRuntime({ docs: { client } });
  const runtime = createCodeRuntime();
  runtime.addProvider(mcp);

  const listed = JSON.parse(await runtime.executeTool(
    "list_mcp_resources",
    "{}",
  ));
  assert.deepEqual(JSON.parse(listed.output), {
    resources: [
      { server: "docs", uri: "docs://one", name: "One" },
      { server: "docs", uri: "docs://two", name: "Two" },
    ],
  });

  const templates = JSON.parse(await runtime.executeTool(
    "list_mcp_resource_templates",
    JSON.stringify({ server: "docs" }),
  ));
  assert.deepEqual(JSON.parse(templates.output), {
    server: "docs",
    resourceTemplates: [{ server: "docs", uriTemplate: "docs://{slug}", name: "Docs" }],
  });

  const read = JSON.parse(await runtime.executeTool(
    "read_mcp_resource",
    JSON.stringify({ server: "docs", uri: "docs://one" }),
  ));
  assert.deepEqual(JSON.parse(read.output), {
    contents: [{ uri: "docs://one", text: "resource body" }],
    server: "docs",
    uri: "docs://one",
  });
});

test("remote MCP failures are reported by tool_search without breaking agent creation", async () => {
  const mcp = await createMcpRuntime({
    unavailable: {
      client: {
        async listTools() { throw new Error("connection refused"); },
        async callTool() { throw new Error("unreachable"); },
      },
    },
  });
  const runtime = createCodeRuntime();
  runtime.addProvider(mcp);
  const result = JSON.parse(await runtime.executeTool(
    "tool_search",
    JSON.stringify({ query: "anything" }),
  ));
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output).failed_servers, {
    unavailable: "connection refused",
  });
});

test("MCP startup timeout bounds complete paginated discovery", async () => {
  let pages = 0;
  const mcp = await createMcpRuntime({
    slow: {
      startupTimeoutMs: 20,
      client: {
        async listTools(_params, options) {
          pages += 1;
          if (pages === 1) return { tools: [], nextCursor: "next" };
          await new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
        },
      },
    },
  });
  const runtime = createCodeRuntime();
  runtime.addProvider(mcp);
  const result = JSON.parse(await runtime.executeTool(
    "tool_search",
    JSON.stringify({ query: "slow" }),
  ));
  assert.match(
    JSON.parse(result.output).failed_servers.slow,
    /startup exceeded 20 milliseconds/,
  );
  assert.equal(pages, 2);
});

test("remote MCP tools retry payment challenges through McpClient.wrap", async () => {
  const challenge = Challenge.from({
    id: "nanocodex-paid-mcp",
    intent: "charge",
    method: "tempo",
    realm: "mercator.tempoxyz.dev",
    request: {},
  });
  const calls = [];
  let credentials = 0;
  const client = {
    async listTools() {
      return {
        tools: [{ name: "premium", inputSchema: { type: "object" } }],
      };
    },
    async callTool(params) {
      calls.push(params);
      if (calls.length === 1) {
        throw new McpError(Mcp.paymentRequiredCode, "Payment Required", {
          challenges: [challenge],
          httpStatus: 402,
        });
      }
      assert.ok(params._meta?.[Mcp.credentialMetaKey]);
      return {
        content: [{ type: "text", text: "paid MCP result" }],
        _meta: {
          [Mcp.receiptMetaKey]: {
            method: "tempo",
            reference: "0xreceipt",
            status: "success",
            timestamp: new Date().toISOString(),
          },
        },
      };
    },
  };
  const method = Method.toClient(Methods.charge, {
    async createCredential({ challenge: selected }) {
      credentials += 1;
      return Credential.serialize({
        challenge: selected,
        payload: { signature: "0xsignature", type: "transaction" },
      });
    },
  });
  const mcp = await createMcpRuntime({
    mercator: {
      client,
      payment: { methods: [method] },
    },
  });

  const result = await mcp.resolve("mcp__mercator__premium").handler({});
  assert.equal(credentials, 1);
  assert.equal(calls.length, 2);
  assert.equal(result.content[0].text, "paid MCP result");
  assert.equal(result.receipt.status, "success");
});
