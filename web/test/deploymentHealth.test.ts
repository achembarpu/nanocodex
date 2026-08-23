import assert from "node:assert/strict";
import test from "node:test";
import { createDeploymentHealthResource } from "../src/deploymentHealth.ts";

test("deployment health is single-flight and cached across shell consumers", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const resource = createDeploymentHealthResource(async () => {
    calls += 1;
    await blocked;
    return Response.json({
      agent_configured: true,
      credential_source: "subscription",
      deployment_sha: "a".repeat(40),
    });
  });

  const first = resource.read();
  const second = resource.read();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
  assert.equal((await resource.read()).credentialSource, "subscription");
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
      credential_source: "user",
      deployment_sha: "b".repeat(40),
    });
  });

  assert.deepEqual(await resource.read(), {
    agentConfigured: false,
    authMode: undefined,
    credentialSource: null,
    deploymentSha: undefined,
    interactiveAuth: true,
    modelAccessMode: "per_user",
  });
  resource.invalidate();
  assert.equal((await resource.refresh()).credentialSource, "user");
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
      credential_source: call === 1 ? "subscription" : "user",
    });
  });

  const obsolete = resource.read();
  resource.invalidate();
  const current = resource.refresh();
  assert.equal(calls, 2);
  releases[0]?.();
  assert.equal((await obsolete).credentialSource, "subscription");
  releases[1]?.();
  assert.equal((await current).credentialSource, "user");
  assert.equal((await resource.read()).credentialSource, "user");
});

test("managed health disables interactive auth even while the broker is unavailable", async () => {
  let ready = false;
  const resource = createDeploymentHealthResource(async () => Response.json({
    agent_configured: ready,
    auth_mode: "chatgpt",
    credential_source: ready ? "managed" : null,
    interactive_auth: false,
    model_access_mode: "managed",
  }));
  assert.deepEqual(await resource.read(), {
    agentConfigured: false,
    authMode: "chatgpt",
    credentialSource: null,
    deploymentSha: undefined,
    interactiveAuth: false,
    modelAccessMode: "managed",
  });
  ready = true;
  resource.invalidate();
  assert.equal((await resource.refresh()).credentialSource, "managed");
});
