import assert from "node:assert/strict";
import test from "node:test";
import { createDeploymentHealthResource } from "../src/deploymentHealth.ts";
import { createDeploymentRolloverGuard } from "../src/useDeploymentRollover.ts";

const deployment = (deploymentSha?: string) => Object.freeze({
  agentConfigured: true,
  credentialSource: "brokered" as const,
  deploymentSha,
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
    } : {
      agent_configured: true,
      credential_source: "brokered",
      deployment_sha: "b".repeat(40),
    });
  });

  assert.deepEqual(await resource.read(), {
    agentConfigured: false,
    credentialSource: null,
    deploymentSha: undefined,
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

test("brokered health naturally reports whether the account has a connection", async () => {
  let ready = false;
  const resource = createDeploymentHealthResource(async () => Response.json({
    agent_configured: ready,
    credential_source: ready ? "brokered" : null,
  }));
  assert.deepEqual(await resource.read(), {
    agentConfigured: false,
    credentialSource: null,
    deploymentSha: undefined,
  });
  ready = true;
  resource.invalidate();
  assert.equal((await resource.refresh()).credentialSource, "brokered");
});
