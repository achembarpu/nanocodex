const hosts = new Map();
let nextRouteId = 1n;

export function own(host, store, journalId) {
  if ((store === undefined) !== (journalId === undefined)) {
    throw new TypeError("durability and durabilityId must be supplied together");
  }
  const routeId = `durability-route-${nextRouteId++}`;
  bind(routeId, host, store, journalId);
  return Object.freeze({
    id: routeId,
    abandon: () => abandon(host, routeId),
    retain: () => retain(host, routeId),
    release: () => release(host, routeId),
  });
}

function bind(routeId, host, store, journalId) {
  hosts.set(routeId, { host, store, journalId, references: 0 });
}

export function retain(host, routeId) {
  const ownership = hosts.get(routeId);
  if (!ownership || ownership.host !== host) {
    throw new Error(`Nanocodex durability route is not bound to this host: ${routeId}`);
  }
  ownership.references += 1;
}

export function release(host, routeId) {
  const ownership = hosts.get(routeId);
  if (!ownership || ownership.host !== host) return;
  if (ownership.references > 0) ownership.references -= 1;
  if (ownership.references === 0) hosts.delete(routeId);
}

export function abandon(host, routeId) {
  const ownership = hosts.get(routeId);
  if (ownership?.host === host && ownership.references === 0) hosts.delete(routeId);
}

export async function acquire(routeId, journalId, ownerId) {
  const stored = await requiredRoute(routeId, journalId).store.acquire(
    journalId,
    { ownerId },
  );
  if (!stored || typeof stored !== "object" || !Array.isArray(stored.batches)) {
    throw new TypeError("durability.acquire() must return { ownerId, fence, revision, batches }");
  }
  const acquiredOwnerId = requiredString(stored.ownerId, "durability owner ID");
  if (acquiredOwnerId !== ownerId) {
    throw new TypeError("durability.acquire() must return the requested owner ID");
  }
  return JSON.stringify({
    owner_id: acquiredOwnerId,
    fence: revision(stored.fence, "durability owner fence"),
    revision: revision(stored.revision, "durability load revision"),
    batches: stored.batches.map((batch) => ({
      revision: revision(batch?.revision, "durability batch revision"),
      payload: requiredString(batch?.payload, "durability batch payload"),
    })),
  });
}

export async function append(
  routeId,
  journalId,
  ownerId,
  fence,
  expectedRevision,
  payload,
) {
  const result = await requiredRoute(routeId, journalId).store.append(journalId, {
    ownerId,
    fence,
    expectedRevision,
    payload,
  });
  if (result?.status === "appended") {
    return JSON.stringify({
      status: "appended",
      revision: revision(result.revision, "durability append revision"),
    });
  }
  if (result?.status === "conflict") {
    return JSON.stringify({
      status: "conflict",
      actual_revision: revision(result.actualRevision, "durability conflict revision"),
    });
  }
  if (result?.status === "not_committed") {
    return JSON.stringify({
      status: "not_committed",
      message: requiredString(result.message, "durability not-committed message"),
    });
  }
  if (result?.status === "fenced") {
    return JSON.stringify({ status: "fenced" });
  }
  throw new TypeError(
    "durability.append() must return an appended, conflict, fenced, or not_committed result",
  );
}

export async function compact(
  routeId,
  journalId,
  ownerId,
  fence,
  expectedRevision,
  payload,
) {
  const store = requiredRoute(routeId, journalId).store;
  if (typeof store.compact !== "function") {
    return JSON.stringify({
      status: "not_committed",
      message: "durability store does not support journal compaction",
    });
  }
  const result = await store.compact(journalId, {
    ownerId,
    fence,
    expectedRevision,
    payload,
  });
  if (result?.status === "compacted") {
    return JSON.stringify({
      status: "compacted",
      revision: revision(result.revision, "durability compact revision"),
    });
  }
  if (result?.status === "conflict") {
    return JSON.stringify({
      status: "conflict",
      actual_revision: revision(result.actualRevision, "durability conflict revision"),
    });
  }
  if (result?.status === "not_committed") {
    return JSON.stringify({
      status: "not_committed",
      message: requiredString(result.message, "durability not-committed message"),
    });
  }
  if (result?.status === "fenced") return JSON.stringify({ status: "fenced" });
  throw new TypeError(
    "durability.compact() must return a compacted, conflict, fenced, or not_committed result",
  );
}

function requiredRoute(routeId, journalId) {
  const route = hosts.get(routeId);
  if (!route) throw new Error(`no Nanocodex host owns durability route: ${routeId}`);
  if (route.journalId !== journalId) {
    throw new Error(`Nanocodex durability route does not own journal: ${journalId}`);
  }
  const store = route.store;
  if (!store || typeof store.acquire !== "function" || typeof store.append !== "function") {
    throw new TypeError("the selected Nanocodex host must define a durability store");
  }
  return route;
}

function revision(value, name) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be an unsigned decimal string`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}
