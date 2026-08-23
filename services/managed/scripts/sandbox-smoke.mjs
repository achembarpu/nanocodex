const baseUrl = process.env.NANOCODEX_WORKER_URL ?? "http://127.0.0.1:8787";
const adminToken = process.env.NANOCODEX_ADMIN_TOKEN ?? "local-admin-token";
const timeoutMs = Number(process.env.NANOCODEX_SANDBOX_SMOKE_TIMEOUT_MS ?? 300_000);
const authorization = { authorization: `Bearer ${adminToken}` };
let setup;
let finished = false;

try {
  const setupResponse = await fetch(`${baseUrl}/admin/sandbox-smoke`, {
    method: "POST",
    headers: authorization,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const setupBody = await setupResponse.text();
  if (!setupResponse.ok) {
    throw new Error(`sandbox setup failed with HTTP ${setupResponse.status}: ${setupBody}`);
  }
  setup = JSON.parse(setupBody);
  if (setup.status !== "ready" || !Array.isArray(setup.checks) || setup.checks.length !== 8) {
    throw new Error(`sandbox setup returned an unexpected result: ${setupBody}`);
  }

  if (!["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname)) {
    await waitForPreview(setup.preview_url, setup.marker);
  }
  const finishResponse = await finish(setup.probe_id);
  const finishBody = await finishResponse.text();
  finished = true;
  if (!finishResponse.ok) {
    throw new Error(`sandbox finish failed with HTTP ${finishResponse.status}: ${finishBody}`);
  }
  const result = JSON.parse(finishBody);
  if (result.status !== "ok" || !Array.isArray(result.checks) || result.checks.length !== 1) {
    throw new Error(`sandbox finish returned an unexpected result: ${finishBody}`);
  }
  console.log(JSON.stringify({
    status: "ok",
    probe_id: setup.probe_id,
    checks: [...setup.checks, ...result.checks],
    setup_duration_ms: setup.duration_ms,
    finish_duration_ms: result.duration_ms,
  }));
} finally {
  if (setup?.probe_id && !finished) await finish(setup.probe_id).catch(() => {});
}

function finish(probeId) {
  return fetch(`${baseUrl}/admin/sandbox-smoke`, {
    method: "DELETE",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ probe_id: probeId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function waitForPreview(url, marker) {
  const deadline = Date.now() + 30_000;
  let lastResult = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const body = await response.text();
        if (body === marker) return;
        lastResult = `HTTP ${response.status} with unexpected content`;
      } else {
        lastResult = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastResult = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`preview did not become reachable: ${lastResult}`);
}
