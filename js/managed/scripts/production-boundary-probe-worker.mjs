export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/verify" || url.search !== "") {
      return json({ error: "not_found" }, 404);
    }
    if (!env.NANOCODEX_BOUNDARY_PROBE_TOKEN
      || !await authorized(request, env.NANOCODEX_BOUNDARY_PROBE_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (!env.NANOCODEX || !env.NANOCODEX_BROKER_PROBE_TOKEN) {
      return json({ error: "probe_not_configured" }, 503);
    }

    try {
      await requireBrokerReadiness(env.NANOCODEX, env.NANOCODEX_BROKER_PROBE_TOKEN);
      return json({
        boundary: "private-service-binding",
        broker_ready: true,
        status: "ok",
      });
    } catch {
      return json({ error: "boundary_verification_failed" }, 502);
    }
  },
};

async function requireBrokerReadiness(broker, token) {
  const response = await broker.fetch(
    "https://broker.internal/.well-known/nanocodex/broker-readiness",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
  );
  const ready = await boundedJson(response, 4 * 1024);
  if (response.status !== 200 || ready?.ready !== true
    || Object.keys(ready).length !== 1
    || !/no-store/i.test(response.headers.get("cache-control") ?? "")) {
    throw new Error("private broker readiness failed");
  }
}

async function boundedJson(response, limit) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > limit) {
    throw new Error("response exceeded probe limit");
  }
  return JSON.parse(text);
}

async function authorized(request, expected) {
  const actual = request.headers.get("authorization") ?? "";
  const expectedValue = `Bearer ${expected}`;
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedValue)),
  ]);
  const left = new Uint8Array(actualDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
