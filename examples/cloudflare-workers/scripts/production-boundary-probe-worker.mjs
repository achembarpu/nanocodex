const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}~[A-Za-z0-9_-]{43}$/;

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
    if (!env.BROKER || !env.NANOCODEX_BROKER_PROBE_TOKEN
      || !env.MULTIPLAYER_ALLOCATOR_TOKEN || !env.MULTIPLAYER_BACKEND
      || !env.MULTIPLAYER_QUOTA || !validPublicOrigin(env.PUBLIC_ORIGIN)
      || (env.EXPECTED_AUTH_MODE !== "api_key" && env.EXPECTED_AUTH_MODE !== "chatgpt")) {
      return json({ error: "probe_not_configured" }, 503);
    }

    let roomId;
    let ownerCookie;
    let deleted = false;
    try {
      await requireBrokerReadiness(env.BROKER, env.NANOCODEX_BROKER_PROBE_TOKEN);
      const activeRoomsBefore = await activeRooms(env.MULTIPLAYER_QUOTA);
      const created = await env.MULTIPLAYER_BACKEND.fetch(
        "https://managed.internal/v1/rooms",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.MULTIPLAYER_ALLOCATOR_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            display_name: "Production boundary probe",
            public_origin: env.PUBLIC_ORIGIN,
          }),
        },
      );
      if (created.status !== 201) {
        await created.body?.cancel();
        throw new Error("room creation failed");
      }
      const receipt = await boundedJson(created, 8 * 1024);
      if (receipt && typeof receipt === "object" && ROOM_ID.test(receipt.room_id)) {
        roomId = receipt.room_id;
        ownerCookie = exactOwnerCookie(created.headers.get("set-cookie"), roomId);
      }
      if (!roomId || receipt.auth_mode !== env.EXPECTED_AUTH_MODE
        || Object.hasOwn(receipt, "agent_id")) {
        throw new Error("room creation receipt was invalid");
      }
      if (!ownerCookie) throw new Error("room creation omitted its owner cookie");

      const activeRoomsDuring = await activeRooms(env.MULTIPLAYER_QUOTA);
      if (activeRoomsDuring !== activeRoomsBefore + 1) {
        throw new Error("room quota did not record exactly one probe allocation");
      }
      await deleteRoom(env.MULTIPLAYER_BACKEND, roomId, ownerCookie);
      deleted = true;
      const activeRoomsAfter = await waitForActiveRooms(
        env.MULTIPLAYER_QUOTA,
        activeRoomsBefore,
      );
      return json({
        active_rooms_after: activeRoomsAfter,
        active_rooms_before: activeRoomsBefore,
        boundary: "private-service-binding",
        broker_ready: true,
        created: true,
        deleted: true,
        status: "ok",
      });
    } catch {
      if (roomId && ownerCookie && !deleted) {
        try {
          await deleteRoom(env.MULTIPLAYER_BACKEND, roomId, ownerCookie);
        } catch {
          // The caller treats this generic failure as a stopped rollout. The
          // room lease remains bounded if owner cleanup cannot complete.
        }
      }
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

async function activeRooms(namespace) {
  const response = await namespace.getByName("global").fetch(
    "https://quota.internal/status",
  );
  const status = await boundedJson(response, 4 * 1024);
  if (response.status !== 200 || !Number.isSafeInteger(status?.active_rooms)) {
    throw new Error("quota status failed");
  }
  return status.active_rooms;
}

async function waitForActiveRooms(namespace, expected) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const observed = await activeRooms(namespace);
    if (observed === expected) return observed;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("room quota did not return to its baseline");
}

async function deleteRoom(backend, roomId, cookie) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await backend.fetch(
      `https://managed.internal/v1/rooms/${encodeURIComponent(roomId)}`,
      { method: "DELETE", headers: { cookie } },
    );
    if (response.status === 204) return;
    await response.body?.cancel();
    if (response.status !== 503) throw new Error("room owner deletion failed");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("room owner deletion did not converge");
}

function exactOwnerCookie(setCookie, roomId) {
  if (!setCookie) return undefined;
  const cookie = setCookie.split(";", 1)[0];
  const expectedName = `nanocodex_room_${roomId.replaceAll("-", "")}`;
  const separator = cookie.indexOf("=");
  if (separator < 0 || cookie.slice(0, separator) !== expectedName
    || !/^[A-Za-z0-9_-]{43}$/.test(cookie.slice(separator + 1))) {
    return undefined;
  }
  return cookie;
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

function validPublicOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.username === ""
      && url.password === "" && url.port === "";
  } catch {
    return false;
  }
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
