const hosts = new Map();

export function own(host, store, journalId) {
  if ((store === undefined) !== (journalId === undefined)) {
    throw new TypeError("durability and durabilityId must be supplied together");
  }
  bind(host, store, journalId);
  return Object.freeze({
    id: journalId,
    abandon: () => abandon(host, journalId),
    retain: () => retain(host, journalId),
    release: () => release(host, journalId),
  });
}

function bind(host, store, journalId) {
  const existing = hosts.get(journalId);
  if (existing && existing.host !== host) {
    throw new Error(`Nanocodex durability journal is already active: ${journalId}`);
  }
  hosts.set(journalId, existing ?? { host, store, references: 0 });
}

export function retain(host, journalId) {
  const ownership = hosts.get(journalId);
  if (!ownership || ownership.host !== host) {
    throw new Error(`Nanocodex durability journal is not bound to this host: ${journalId}`);
  }
  ownership.references += 1;
}

export function release(host, journalId) {
  const ownership = hosts.get(journalId);
  if (!ownership || ownership.host !== host) return;
  if (ownership.references > 0) ownership.references -= 1;
  if (ownership.references === 0) hosts.delete(journalId);
}

export function abandon(host, journalId) {
  const ownership = hosts.get(journalId);
  if (ownership?.host === host && ownership.references === 0) hosts.delete(journalId);
}

export async function load(journalId) {
  const stored = await requiredStore(journalId).load(journalId);
  if (!stored || typeof stored !== "object" || !Array.isArray(stored.batches)) {
    throw new TypeError("durability.load() must return { revision, batches }");
  }
  return JSON.stringify({
    revision: revision(stored.revision, "durability load revision"),
    batches: stored.batches.map((batch) => ({
      revision: revision(batch?.revision, "durability batch revision"),
      payload: requiredString(batch?.payload, "durability batch payload"),
    })),
  });
}

export async function append(journalId, expectedRevision, payload) {
  const result = await requiredStore(journalId).append(journalId, {
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
  throw new TypeError("durability.append() must return an appended or conflict result");
}

function requiredStore(journalId) {
  const host = hosts.get(journalId)?.host;
  if (!host) throw new Error(`no Nanocodex host owns durability journal: ${journalId}`);
  const store = hosts.get(journalId)?.store;
  if (!store || typeof store.load !== "function" || typeof store.append !== "function") {
    throw new TypeError("the selected Nanocodex host must define a durability store");
  }
  return store;
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
