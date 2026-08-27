import assert from "node:assert/strict";
import test from "node:test";
import { createDeploymentHealthResource } from "../src/deploymentHealth.ts";
import { invalidateModelHealthForAccountTransition } from "../src/modelHealthAccount.ts";
import { createDeploymentRolloverGuard } from "../src/useDeploymentRollover.ts";

const deployment = (deploymentSha?: string) => Object.freeze({
  agentConfigured: true,
  credentialSource: "brokered" as const,
  deploymentSha,
  voiceEnabled: true,
});

test("deployment rollover coalesces matching live-generation checks", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const guard = createDeploymentRolloverGuard({
    currentDeploymentSha: "a".repeat(40),
    async refresh() {
      calls += 1;
      await blocked;
      return deployment("a".repeat(40));
    },
    reload() { assert.fail("a matching deployment must not reload"); },
  });

  const first = guard();
  const second = guard();
  assert.equal(first, second);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  await guard();
  assert.equal(calls, 2, "each model boundary checks current deployment health");
});

test("deployment rollover reloads once and permanently fences stale JavaScript", async () => {
  let calls = 0;
  let reloads = 0;
  const guard = createDeploymentRolloverGuard({
    currentDeploymentSha: "a".repeat(40),
    async refresh() {
      calls += 1;
      return deployment("b".repeat(40));
    },
    reload() { reloads += 1; },
  });

  const first = guard();
  await Promise.resolve();
  await Promise.resolve();
  const second = guard();
  let settled = false;
  void first.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  void second.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(calls, 1);
  assert.equal(reloads, 1);
  assert.equal(settled, false, "stale code cannot continue while navigation is pending");
});

test("deployment rollover fails closed when health cannot attest a generation", async () => {
  let reloads = 0;
  for (const refresh of [
    async () => deployment(undefined),
    async () => { throw new Error("offline"); },
  ]) {
    const guard = createDeploymentRolloverGuard({
      currentDeploymentSha: "a".repeat(40),
      refresh,
      reload() { reloads += 1; },
    });
    await assert.rejects(guard());
  }
  assert.equal(reloads, 0);
});

test("deployment health is single-flight and cached across shell consumers", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const resource = createDeploymentHealthResource(async () => {
    calls += 1;
    await blocked;
    return Response.json({
      agent_configured: true,
      credential_source: "brokered",
      deployment_sha: "a".repeat(40),
      voice_enabled: true,
    });
  });

  const first = resource.read();
  const second = resource.read();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
  assert.equal((await resource.read()).credentialSource, "brokered");
  assert.equal(calls, 1);
});

test("deployment health refreshes after invalidation and rejects malformed credentials", async () => {
  let calls = 0;
  const resource = createDeploymentHealthResource(async () => {
    calls += 1;
    return Response.json(calls === 1 ? {
      agent_configured: true,
      credential_source: "unexpected",
      deployment_sha: null,
      voice_enabled: true,
    } : {
      agent_configured: true,
      credential_source: "brokered",
      deployment_sha: "b".repeat(40),
      voice_enabled: true,
    });
  });

  assert.deepEqual(await resource.read(), {
    agentConfigured: false,
    credentialSource: null,
    deploymentSha: undefined,
    voiceEnabled: false,
  });
  resource.invalidate();
  assert.equal((await resource.refresh()).credentialSource, "brokered");
  assert.equal(calls, 2);
});

test("invalidation detaches an obsolete in-flight health request", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const resource = createDeploymentHealthResource(async () => {
    calls += 1;
    const call = calls;
    await new Promise<void>((resolve) => releases.push(resolve));
    return Response.json({
      agent_configured: true,
      credential_source: "brokered",
      voice_enabled: true,
    });
  });

  const obsolete = resource.read();
  resource.invalidate();
  const current = resource.refresh();
  assert.equal(calls, 2);
  releases[0]?.();
  assert.equal((await obsolete).credentialSource, "brokered");
  releases[1]?.();
  assert.equal((await current).credentialSource, "brokered");
  assert.equal((await resource.read()).credentialSource, "brokered");
});

test("first passkey sign-in detaches signed-out health and reads the account's voice entitlement", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const resource = createDeploymentHealthResource(async () => {
    calls += 1;
    const call = calls;
    await new Promise<void>((resolve) => releases.push(resolve));
    return Response.json(call === 1 ? {
      agent_configured: false,
      credential_source: null,
      voice_enabled: false,
    } : {
      agent_configured: true,
      credential_source: "brokered",
      voice_enabled: true,
    });
  });

  const signedOutRollover = resource.refresh();
  assert.equal(
    invalidateModelHealthForAccountTransition(undefined, "remembered-account", resource),
    true,
  );
  const signedIn = resource.refresh();
  assert.equal(calls, 2, "sign-in does not coalesce with the pre-auth health request");

  releases[0]?.();
  assert.equal((await signedOutRollover).voiceEnabled, false);
  releases[1]?.();
  assert.deepEqual(await signedIn, {
    agentConfigured: true,
    credentialSource: "brokered",
    deploymentSha: undefined,
    voiceEnabled: true,
  });
  assert.equal((await resource.read()).voiceEnabled, true);
});

test("account switching cannot reuse another account's cached voice entitlement", async () => {
  let account = "voice";
  let calls = 0;
  const resource = createDeploymentHealthResource(async () => {
    calls += 1;
    const voiceEnabled = account === "voice";
    return Response.json({
      agent_configured: voiceEnabled,
      credential_source: voiceEnabled ? "brokered" : null,
      voice_enabled: voiceEnabled,
    });
  });

  assert.equal((await resource.read()).voiceEnabled, true);
  account = "no-voice";
  assert.equal(
    invalidateModelHealthForAccountTransition("voice-account", "no-voice-account", resource),
    true,
  );
  assert.equal((await resource.refresh()).voiceEnabled, false);
  assert.equal(calls, 2);
  assert.equal(
    invalidateModelHealthForAccountTransition("no-voice-account", "no-voice-account", resource),
    false,
  );
  assert.equal((await resource.read()).voiceEnabled, false);
  assert.equal(calls, 2, "stable account renders retain the current account's cache");
});

test("brokered health naturally reports whether the account has a connection", async () => {
  let ready = false;
  const resource = createDeploymentHealthResource(async () => Response.json({
    agent_configured: ready,
    credential_source: ready ? "brokered" : null,
    voice_enabled: ready,
  }));
  assert.deepEqual(await resource.read(), {
    agentConfigured: false,
    credentialSource: null,
    deploymentSha: undefined,
    voiceEnabled: false,
  });
  ready = true;
  resource.invalidate();
  assert.equal((await resource.refresh()).credentialSource, "brokered");
});

test("OpenAI API-key health keeps text ready but never enables voice", async () => {
  const resource = createDeploymentHealthResource(async () => Response.json({
    agent_configured: true,
    credential_source: "user",
    voice_enabled: true,
  }));
  assert.deepEqual(await resource.read(), {
    agentConfigured: true,
    credentialSource: "user",
    deploymentSha: undefined,
    voiceEnabled: false,
  });
});

test("legacy direct ChatGPT health is treated as brokered voice access", async () => {
  const resource = createDeploymentHealthResource(async () => Response.json({
    agent_configured: true,
    credential_source: "subscription",
    voice_enabled: true,
  }));
  assert.equal((await resource.read()).voiceEnabled, true);
});
