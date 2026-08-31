import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  authenticate,
  createApiKey,
  type AccountAuthEnv,
  type OrganizationCapability,
} from "../src/account-auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const testEnv = env as unknown as AccountAuthEnv;
const OWNER_CAPABILITIES = [
  "agents:read",
  "agents:portability",
  "agents:write",
  "api_keys:read",
  "api_keys:write",
  "history:read",
  "memory:read",
  "memory:write",
  "tools:use",
  "organization:read",
  "organization:write",
] as const satisfies readonly OrganizationCapability[];
const LEGACY_OWNER_CAPABILITIES = OWNER_CAPABILITIES.filter((capability) => (
  capability !== "agents:portability"
  && capability !== "history:read"
  && capability !== "memory:read"
  && capability !== "memory:write"
));

describe("organization authorization foundation", () => {
  it("allocates one stable organization and root team on first account PUT", async () => {
    const userId = crypto.randomUUID();
    const account = testEnv.NANOCODEX_USERS.getByName(userId);
    const first = await account.fetch(accountPut(userId, false));
    expect(first.status).toBe(200);
    const firstRecord = await first.json<AccountRecord>();
    expect(firstRecord.organizationId).toMatch(UUID);
    expect(firstRecord).not.toHaveProperty("rootTeamId");

    const repeated = await account.fetch(accountPut(userId, true));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      organizationId: firstRecord.organizationId,
      persistent: true,
    });

    const organization = testEnv.NANOCODEX_ORGANIZATIONS.getByName(firstRecord.organizationId);
    const metadata = await organization.fetch("https://organization.internal/metadata");
    const organizationRecord = await metadata.json<{
      id: string;
      name: string | null;
      rootTeam: { id: string; name: string | null };
      authorizationEpoch: number;
    }>();
    expect(organizationRecord).toMatchObject({
      id: firstRecord.organizationId,
      name: null,
      rootTeam: { id: expect.stringMatching(UUID), name: null },
      authorizationEpoch: 1,
    });
    expect(organizationRecord.rootTeam.id).not.toBe(firstRecord.organizationId);

    const grant = await organization.fetch(
      `https://organization.internal/resolve?userId=${userId}`,
    );
    expect(await grant.json()).toEqual({
      organizationId: firstRecord.organizationId,
      teamId: organizationRecord.rootTeam.id,
      role: "owner",
      authorizationEpoch: 1,
      capabilities: [
        "agents:read",
        "agents:portability",
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
    });
  });

  it("serves owner metadata and requires same-origin account auth for mutation", async () => {
    const me = await SELF.fetch("https://example.test/v1/me");
    expect(me.status).toBe(200);
    const cookie = me.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const identity = await me.json<{
      user: { id: string };
      organization: { id: string };
      team: { id: string };
      role: string;
    }>();
    expect(identity).toMatchObject({ role: "owner" });
    expect(identity.organization.id).toMatch(UUID);
    expect(identity.team.id).toMatch(UUID);
    const principal = await authenticate(new Request("https://example.test/v1/me", {
      headers: { cookie: cookie! },
    }), testEnv);
    expect(principal).toMatchObject({
      kind: "account_session",
      userId: identity.user.id,
      organizationId: identity.organization.id,
      teamId: identity.team.id,
      role: "owner",
      subjectId: `user:${identity.user.id}`,
      authorizationEpoch: 1,
    });
    expect(principal?.credentialId).toMatch(/^account_session:[A-Za-z0-9_-]{43}$/);

    const metadata = await SELF.fetch("https://example.test/v1/organization", {
      headers: { cookie: cookie! },
    });
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      id: identity.organization.id,
      name: null,
      rootTeam: { id: identity.team.id, name: null },
      authorizationEpoch: 1,
    });

    const crossOrigin = await SELF.fetch("https://example.test/v1/organization", {
      method: "PATCH",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ name: "Research" }),
    });
    expect(crossOrigin.status).toBe(403);

    const renamed = await SELF.fetch("https://example.test/v1/organization", {
      method: "PATCH",
      headers: {
        cookie: cookie!,
        "content-type": "application/json",
        origin: "https://example.test",
      },
      body: JSON.stringify({ name: "  Research team  " }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Research team" });

    const oversized = await SELF.fetch("https://example.test/v1/organization", {
      method: "PATCH",
      headers: {
        cookie: cookie!,
        "content-type": "application/json",
        origin: "https://example.test",
      },
      body: JSON.stringify({ name: "x".repeat(121) }),
    });
    expect(oversized.status).toBe(400);

    const cleared = await SELF.fetch("https://example.test/v1/organization", {
      method: "PATCH",
      headers: {
        cookie: cookie!,
        "content-type": "application/json",
        origin: "https://example.test",
      },
      body: JSON.stringify({ name: null }),
    });
    expect(await cleared.json()).toMatchObject({ name: null });
  });

  it("persists and resolves API keys as validated organization principals", async () => {
    const me = await SELF.fetch("https://example.test/v1/me");
    const cookie = me.headers.get("set-cookie")?.split(";", 1)[0];
    const identity = await me.json<{
      user: { id: string };
      organization: { id: string };
      team: { id: string };
    }>();
    const persisted = await testEnv.NANOCODEX_USERS.getByName(identity.user.id).fetch(
      accountPut(identity.user.id, true),
    );
    expect(persisted.status).toBe(200);
    const created = await SELF.fetch("https://example.test/v1/api-keys", {
      method: "POST",
      headers: {
        cookie: cookie!,
        "content-type": "application/json",
        origin: "https://example.test",
      },
      body: JSON.stringify({ label: "organization fixture" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json<{ api_key: string; key: { id: string } }>();

    const digest = await sha256(body.api_key);
    const stored = await testEnv.NANOCODEX_API_KEYS.getByName(digest).fetch(
      "https://api-key.internal/resolve",
    );
    expect(await stored.json()).toMatchObject({
      id: body.key.id,
      organizationId: identity.organization.id,
      teamId: identity.team.id,
      role: "owner",
      authorizationEpoch: 1,
      capabilities: expect.arrayContaining(["organization:read", "organization:write"]),
    });

    const principal = await authenticate(new Request("https://example.test/v1/me", {
      headers: { authorization: `Bearer ${body.api_key}` },
    }), testEnv);
    expect(principal).toMatchObject({
      kind: "api_key",
      userId: identity.user.id,
      organizationId: identity.organization.id,
      teamId: identity.team.id,
      role: "owner",
      subjectId: `api_key:${body.key.id}`,
      credentialId: body.key.id,
      authorizationEpoch: 1,
    });

    const forbidden = await SELF.fetch("https://example.test/v1/organization", {
      headers: { authorization: `Bearer ${body.api_key}` },
    });
    expect(forbidden.status).toBe(403);
  });

  it("resolves stale owners with canonical capabilities while preserving API-key snapshots", async () => {
    const account = await SELF.fetch("https://example.test/v1/me");
    const cookie = account.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const identity = await account.json<{
      user: { id: string };
      organization: { id: string };
    }>();
    const owner = {
      userId: identity.user.id,
      organization: testEnv.NANOCODEX_ORGANIZATIONS.getByName(identity.organization.id),
    };
    await replaceMembership(owner, "owner", LEGACY_OWNER_CAPABILITIES);

    const principal = await authenticate(new Request("https://example.test/v1/me", {
      headers: { cookie: cookie! },
    }), testEnv);
    expect(principal).toMatchObject({
      kind: "account_session",
      role: "owner",
      capabilities: OWNER_CAPABILITIES,
    });

    const legacyMaterial = {
      id: "legacyowners",
      token: `ncx_live_legacyowners_${"l".repeat(43)}`,
      createdAt: 1,
    };
    await createApiKey(
      testEnv,
      { ...principal!, capabilities: LEGACY_OWNER_CAPABILITIES },
      "issued before hosted memory",
      legacyMaterial,
    );
    const legacyPrincipal = await authenticate(new Request("https://example.test/v1/me", {
      headers: { authorization: `Bearer ${legacyMaterial.token}` },
    }), testEnv);
    expect(legacyPrincipal).toMatchObject({
      kind: "api_key",
      role: "owner",
      capabilities: LEGACY_OWNER_CAPABILITIES,
    });

    const currentMaterial = {
      id: "currentowner",
      token: `ncx_live_currentowner_${"c".repeat(43)}`,
      createdAt: 2,
    };
    await createApiKey(testEnv, principal!, "current general-purpose key", currentMaterial);
    const currentPrincipal = await authenticate(new Request("https://example.test/v1/me", {
      headers: { authorization: `Bearer ${currentMaterial.token}` },
    }), testEnv);
    expect(currentPrincipal).toMatchObject({
      kind: "api_key",
      role: "owner",
      capabilities: OWNER_CAPABILITIES,
    });
  });

  it("does not expand explicit non-owner capability grants", async () => {
    const member = await provisionOwner();
    const capabilities = ["agents:read", "history:read"] as const;
    await replaceMembership(member, "writer", capabilities);

    const principal = await authenticate(connectRequest(member.userId, capabilities), testEnv);
    expect(principal).toMatchObject({
      kind: "connect_grant",
      role: "writer",
      capabilities,
    });
  });
});

type AccountRecord = {
  organizationId: string;
};

type OwnerFixture = {
  userId: string;
  organization: ReturnType<AccountAuthEnv["NANOCODEX_ORGANIZATIONS"]["getByName"]>;
};

async function provisionOwner(): Promise<OwnerFixture> {
  const userId = crypto.randomUUID();
  const account = testEnv.NANOCODEX_USERS.getByName(userId);
  const response = await account.fetch(accountPut(userId, true));
  expect(response.status).toBe(200);
  const { organizationId } = await response.json<AccountRecord>();
  const organization = testEnv.NANOCODEX_ORGANIZATIONS.getByName(organizationId);
  return { userId, organization };
}

async function replaceMembership(
  fixture: OwnerFixture,
  role: "owner" | "writer" | "reader",
  capabilities: readonly OrganizationCapability[],
): Promise<void> {
  await runInDurableObject(fixture.organization, async (_instance, state) => {
    const key = `membership:user:${fixture.userId}`;
    const membership = await state.storage.get<Record<string, unknown>>(key);
    expect(membership).toBeDefined();
    await state.storage.put(key, { ...membership, role, capabilities });
  });
}

function connectRequest(
  userId: string,
  capabilities: readonly OrganizationCapability[],
): Request {
  return new Request("https://nanocodex.internal/v1/me", {
    headers: {
      "x-nanocodex-connect-user": userId,
      "x-nanocodex-connect-grant-id": `0x${"a".repeat(64)}`,
      "x-nanocodex-connect-app-id": "atlas-workspace",
      "x-nanocodex-connect-app-origin": "https://app.example",
      "x-nanocodex-connect-account": `0x${"1".repeat(40)}`,
      "x-nanocodex-connect-agent-id": "11111111-1111-4111-8111-111111111111",
      "x-nanocodex-connect-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      "x-nanocodex-connect-resources": JSON.stringify(["urn:nanocodex:agent:run"]),
      "x-nanocodex-connect-capabilities": JSON.stringify(capabilities),
      "x-nanocodex-connect-connectors": "[]",
      "x-nanocodex-connect-mcp-ids": "[]",
    },
  });
}

function accountPut(userId: string, persistent: boolean): Request {
  return jsonRequest("https://user.internal/account", "PUT", { id: userId, persistent });
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
