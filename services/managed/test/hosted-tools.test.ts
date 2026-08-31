import { env, SELF } from "cloudflare:test";
import { createTools } from "nanocodex";
import { Agent } from "nanocodex/managed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../src/index";

const testEnv = env as unknown as Env;
const USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const API_KEY = `ncx_live_${"d".repeat(12)}_${"h".repeat(43)}`;
const ACCOUNT_SESSION = "b".repeat(64);
const MESSAGE_TIMEOUT_MS = 20_000;
const createdAgents = new Set<string>();

beforeAll(async () => seedApiKey());

afterAll(async () => {
  await Promise.all([...createdAgents].map(async (agentId) => {
    await authenticatedFetch(`https://example.test/v1/agents/${agentId}`, { method: "DELETE" });
  }));
});

describe("managed Hosted Tools", () => {
  it("authenticates the reverse endpoint and rejects the replaced socket", async () => {
    const agentId = await createAgent();
    const endpoint = `https://example.test/v1/agents/${agentId}/tool-host`;
    const unauthenticated = await SELF.fetch(endpoint, { headers: { upgrade: "websocket" } });
    expect(unauthenticated.status).toBe(401);

    const first = await upgrade(endpoint);
    const firstReady = nextMessage(first);
    first.send(JSON.stringify({ type: "catalog", tools: [] }));
    expect(await firstReady).toEqual({ type: "ready" });

    const pongMessage = nextMessage(first);
    first.send(JSON.stringify({
      type: "ping",
      nonce: "host-heartbeat",
    }));
    expect(await pongMessage).toEqual({
      type: "pong",
      nonce: "host-heartbeat",
    });

    const replaced = nextClose(first);
    const second = await upgrade(endpoint);
    const secondReady = nextMessage(second);
    second.send(JSON.stringify({ type: "catalog", tools: [] }));
    expect(await secondReady).toEqual({ type: "ready" });
    expect(await replaced).toMatchObject({
      code: 1008,
      reason: "Hosted Tools attachment replaced",
    });
    second.close(1000, "test complete");
  });

  it("installs attached/cloud parity validation before the first managed turn", async () => {
    const agentId = await createAgent();
    const host = await upgrade(`https://example.test/v1/agents/${agentId}/tool-host`);
    const tools = [mismatchedPriorityCatalogEntry()];
    const rejected = nextClose(host);
    host.send(JSON.stringify({
      type: "catalog",
      tools,
    }));
    expect(await rejected).toMatchObject({
      code: 1008,
      reason: expect.stringContaining("catalog_contract_mismatch"),
    });
  });

  it("executes an attached JavaScript tool through the public Tools API", async () => {
    const agentId = await createAgent();
    const agent = Agent.open(agentId, {
      baseUrl: "https://example.test",
      toolsTransport: (target, options) => upgradeTarget(target, options),
    });
    const warmup = await authenticatedFetch(
      `https://example.test/v1/agents/${agentId}/turns`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "request-before-managed-hosted-tools",
        },
        body: JSON.stringify({
          id: "turn-before-managed-hosted-tools",
          input: "LOAD_AGENT_BEFORE_HOST",
        }),
      },
    );
    expect(warmup.status).toBe(202);
    const warmTerminal = await waitForTurn(agentId, "turn-before-managed-hosted-tools");
    console.log("warm terminal", warmTerminal);
    expect(warmTerminal).toMatchObject({
      type: "turn_completed",
    });

    const tools = await createTools({
      tools: {
        fixture__lookup: {
          description: "Look up one fixture from the attached JavaScript runtime.",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          handler: ({ id }: { id: string }) => ({ id, source: "private-host" }),
        },
      },
    });
    const connector = tools.attach(agent.toolsTarget());
    try {
      const attachment = await connector.connect();
      expect(attachment.connected).toBe(true);

      const started = await authenticatedFetch(
        `https://example.test/v1/agents/${agentId}/turns`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "request-managed-hosted-tools",
          },
          body: JSON.stringify({ id: "turn-managed-hosted-tools", input: "E2E_HOSTED_TOOLS" }),
        },
      );
      expect(started.status).toBe(202);
      expect(await waitForTurn(agentId, "turn-managed-hosted-tools")).toMatchObject({
        type: "turn_completed",
        final_message: "MANAGED_HOSTED_TOOLS_OK",
      });
    } finally {
      connector.close();
      await tools.close();
    }
  }, 30_000);

  it("prefers an attached local tool and falls back to its cloud collision after detach", async () => {
    const agentId = await createAgent();
    const agent = Agent.open(agentId, {
      baseUrl: "https://example.test",
      toolsTransport: (target, options) => upgradeTarget(target, options),
    });
    const definition = priorityCatalogEntry().definition;
    const tools = await createTools({
      tools: {
        exec_command: {
          description: definition.description,
          parameters: definition.parameters,
          outputSchema: definition.output_schema,
          handler: ({ cmd }: { cmd: string }) => ({
            command: cmd,
            output: "PRIVATE_LOCAL_EXEC",
            source: "private-local",
          }),
        },
      },
    });
    const connector = tools.attach(agent.toolsTarget());
    try {
      expect((await connector.connect()).connected).toBe(true);
      const localStarted = await startTurn(
        agentId,
        "turn-hosted-local-priority",
        "request-hosted-local-priority",
        "E2E_HOSTED_PRIORITY_LOCAL",
      );
      expect(localStarted.status).toBe(202);
      expect(await waitForTurn(agentId, "turn-hosted-local-priority")).toMatchObject({
        type: "turn_completed",
        final_message: "HOSTED_LOCAL_PRIORITY_OK",
      });

      await connector.close();
      const cloudStarted = await startTurn(
        agentId,
        "turn-hosted-cloud-fallback",
        "request-hosted-cloud-fallback",
        "E2E_HOSTED_PRIORITY_CLOUD",
      );
      expect(cloudStarted.status).toBe(202);
      expect(await waitForTurn(agentId, "turn-hosted-cloud-fallback")).toMatchObject({
        type: "turn_completed",
        final_message: "HOSTED_CLOUD_FALLBACK_OK",
      });
    } finally {
      await connector.close();
      await tools.close();
    }
  }, 40_000);
});

function priorityCatalogEntry() {
  return {
    provider: "javascript",
    remote_name: "exec_command",
    definition: {
      type: "function",
      name: "exec_command",
      description: "Runs a shell command, returning output or a session ID for ongoing interaction.",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Shell command to execute." },
          justification: { type: "string", description: "User-facing approval question for `require_escalated`; omit otherwise." },
          workdir: { type: "string", description: "Working directory for the command. Defaults to the turn cwd." },
          shell: { type: "string", description: "Shell binary to launch. Defaults to the user's default shell." },
          login: { type: "boolean", description: "True runs the shell with -l/-i semantics; false disables them. Defaults to true." },
          tty: { type: "boolean", description: "True allocates a PTY for the command; false or omitted uses plain pipes." },
          yield_time_ms: { type: "number", description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." },
          max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." },
          prefix_rule: { type: "array", items: { type: "string" }, description: "Reusable approval prefix for `cmd`, only with `sandbox_permissions: \"require_escalated\"`; for example [\"git\", \"pull\"]." },
          sandbox_permissions: { type: "string", enum: ["use_default", "require_escalated"], description: "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution." },
        },
        required: ["cmd"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          chunk_id: { type: "string", description: "Chunk identifier included when the response reports one." },
          wall_time_seconds: { type: "number", description: "Elapsed wall time spent waiting for output in seconds." },
          exit_code: { type: "number", description: "Process exit code when the command finished during this call." },
          session_id: { type: "number", description: "Session identifier to pass to write_stdin when the process is still running." },
          original_token_count: { type: "number", description: "Approximate token count before output truncation." },
          output: { type: "string", description: "Command output text, possibly truncated." },
        },
        required: ["wall_time_seconds", "output"],
        additionalProperties: false,
      },
    },
    parallel_safe: false,
    timeout_ms: 120_000,
  };
}

function mismatchedPriorityCatalogEntry() {
  const entry = priorityCatalogEntry();
  return {
    ...entry,
    definition: {
      ...entry.definition,
      description: "An intentionally incompatible attached exec contract.",
      strict: true,
    },
  };
}

async function createAgent(): Promise<string> {
  const created = await authenticatedFetch("https://example.test/v1/agents", { method: "POST" });
  expect(created.status).toBe(201);
  const { agent_id: agentId } = await created.json<{ agent_id: string }>();
  createdAgents.add(agentId);
  return agentId;
}

function startTurn(
  agentId: string,
  id: string,
  idempotencyKey: string,
  input: string,
): Promise<Response> {
  return authenticatedFetch(`https://example.test/v1/agents/${agentId}/turns`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ id, input }),
  });
}

async function upgrade(endpoint: string): Promise<WebSocket> {
  const response = await accountUpgrade(endpoint);
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeTruthy();
  response.webSocket!.accept();
  return response.webSocket!;
}

async function upgradeTarget(
  target: URL,
  options: Readonly<{ headers?: Readonly<Record<string, string>>; credentials?: "include" }>,
): Promise<WebSocket> {
  expect(options).toEqual({ credentials: "include" });
  const endpoint = new URL(target);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  const response = await accountUpgrade(endpoint);
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeTruthy();
  response.webSocket!.accept();
  return response.webSocket!;
}

function nextMessage(socket: WebSocket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for Hosted Tools message")),
      MESSAGE_TIMEOUT_MS,
    );
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      try { resolve(JSON.parse(String(event.data)) as Record<string, any>); }
      catch (error) { reject(error); }
    }, { once: true });
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for Hosted Tools close")),
      MESSAGE_TIMEOUT_MS,
    );
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });
}

async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${API_KEY}`);
  return SELF.fetch(new Request(request, { headers }));
}

async function waitForTurn(agentId: string, turnId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + MESSAGE_TIMEOUT_MS;
  do {
    const response = await authenticatedFetch(
      `https://example.test/v1/agents/${agentId}/turns/${turnId}`,
    );
    expect(response.status).toBe(200);
    const view = await response.json<{ terminal?: Record<string, unknown> }>();
    if (view.terminal) return view.terminal;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${turnId}`);
}

async function seedApiKey(): Promise<void> {
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(API_KEY)),
  );
  let binary = "";
  for (const byte of digestBytes) binary += String.fromCharCode(byte);
  const digest = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const account = testEnv.NANOCODEX_USERS.getByName(USER_ID);
  const provisioned = await account.fetch("https://user.internal/account", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: USER_ID, persistent: true }),
  });
  expect(provisioned.ok).toBe(true);
  const accountRecord = await provisioned.json<{ organizationId: string }>();
  await seedPasskeySession();
  const organization = await testEnv.NANOCODEX_ORGANIZATIONS.getByName(
    accountRecord.organizationId,
  ).fetch("https://organization.internal/metadata");
  expect(organization.ok).toBe(true);
  const metadata = await organization.json<{ rootTeam: { id: string } }>();
  const key = testEnv.NANOCODEX_API_KEYS.getByName(digest);
  await key.fetch("https://api-key.internal/record", { method: "DELETE" });
  const record = await key.fetch("https://api-key.internal/record", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "d".repeat(12),
      label: "hosted-tools-test",
      prefix: API_KEY.slice(0, "ncx_live_".length + 12),
      createdAt: Date.now(),
      digest,
      userId: USER_ID,
      organizationId: accountRecord.organizationId,
      teamId: metadata.rootTeam.id,
      role: "owner",
      authorizationEpoch: 1,
      capabilities: [
        "agents:read",
        "agents:write",
        "api_keys:read",
        "api_keys:write",
        "history:read",
        "memory:read",
        "memory:write",
        "tools:use",
        "organization:read",
        "organization:write",
      ],
    }),
  });
  expect(record.status).toBe(201);
}

async function accountUpgrade(endpoint: string | URL): Promise<Response> {
  return SELF.fetch(endpoint, {
    headers: {
      cookie: `nanocodex_account=${ACCOUNT_SESSION}`,
      origin: "https://example.test",
      upgrade: "websocket",
    },
  });
}

async function seedPasskeySession(): Promise<void> {
  const encodedUserId = btoa(USER_ID).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1_000);
  const auth = testEnv.NANOCODEX_AUTH.getByName("webauthn");
  const stored = await auth.fetch(
    `https://do.invalid/set?key=${encodeURIComponent(`session:${ACCOUNT_SESSION}`)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: {
          credentialId: "hosted-tools-test-credential",
          publicKey: "0x01",
          userId: encodedUserId,
          issuedAt: now,
          expiresAt: now + 60,
        },
        ttl: 60,
      }),
    },
  );
  expect(stored.ok).toBe(true);
}
