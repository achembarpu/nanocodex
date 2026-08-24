import { durabilityRevision } from "../runtime/durability-store.mjs";

const DATABASE_NAME = "nanocodex-browser-durability-v1";
const DATABASE_VERSION = 2;
const OWNERS_STORE = "owners";
const JOURNALS_STORE = "journals";
const BATCHES_STORE = "batches";
const JOURNAL_INDEX = "journalId";
const MAX_REVISION = "18446744073709551615";

/** Creates the Worker-local IndexedDB durability capability. */
export function createIndexedDbDurabilityStore(options = {}) {
  const indexedDb = options.indexedDB ?? globalThis.indexedDB;
  if (!indexedDb || typeof indexedDb.open !== "function") {
    throw new TypeError("browser durability requires IndexedDB");
  }
  const databaseName = options.databaseName ?? DATABASE_NAME;
  if (typeof databaseName !== "string" || !databaseName) {
    throw new TypeError("browser durability database name must be a non-empty string");
  }
  let database;
  const open = () => {
    if (database) return database;
    const opening = openDatabase(indexedDb, databaseName, () => {
      if (database === opening) database = undefined;
    }).catch((error) => {
      if (database === opening) database = undefined;
      throw error;
    });
    database = opening;
    return opening;
  };

  return Object.freeze({
    async load(journalId) {
      validateJournalId(journalId);
      const db = await open();
      const transaction = db.transaction([JOURNALS_STORE, BATCHES_STORE], "readonly");
      const completed = transactionCompletion(transaction);
      const journalRequest = requestResult(transaction.objectStore(JOURNALS_STORE).get(journalId));
      const batchRequest = requestResult(
        transaction.objectStore(BATCHES_STORE).index(JOURNAL_INDEX).getAll(journalId),
      );
      const [journal, storedBatches] = await Promise.all([
        journalRequest,
        batchRequest,
        completed,
      ]);
      const revision = durabilityRevision(journal?.revision ?? "0");
      const batches = storedBatches.map((batch) => ({
        revision: durabilityRevision(batch.revision),
        payload: validatePayload(batch.payload),
      }));
      batches.sort((left, right) => compareRevisions(left.revision, right.revision));
      return Object.freeze({
        revision,
        batches: Object.freeze(batches.map((batch) => Object.freeze(batch))),
      });
    },

    async acquire(journalId, request) {
      validateJournalId(journalId);
      const ownerId = validateOwnerId(request?.ownerId);
      const db = await open();
      const transaction = db.transaction(
        [OWNERS_STORE, JOURNALS_STORE, BATCHES_STORE],
        "readwrite",
      );
      const completed = transactionCompletion(transaction);
      try {
        const outcome = acquireOwner(
          transaction,
          transaction.objectStore(OWNERS_STORE),
          transaction.objectStore(JOURNALS_STORE),
          transaction.objectStore(BATCHES_STORE),
          journalId,
          ownerId,
        );
        const [result] = await Promise.all([outcome, completed]);
        return result;
      } catch (error) {
        await completed.catch(() => {});
        throw error;
      }
    },

    async append(journalId, request) {
      validateJournalId(journalId);
      const ownerId = validateOwnerId(request?.ownerId);
      const fence = durabilityRevision(request?.fence);
      const expectedRevision = durabilityRevision(request?.expectedRevision);
      const payload = validatePayload(request?.payload);
      const db = await open();
      const transaction = db.transaction(
        [OWNERS_STORE, JOURNALS_STORE, BATCHES_STORE],
        "readwrite",
      );
      const completed = transactionCompletion(transaction);
      const owners = transaction.objectStore(OWNERS_STORE);
      const journals = transaction.objectStore(JOURNALS_STORE);
      const batches = transaction.objectStore(BATCHES_STORE);
      try {
        const outcome = compareAndAppend(
          transaction,
          owners,
          journals,
          batches,
          journalId,
          ownerId,
          fence,
          expectedRevision,
          payload,
        );
        const [result] = await Promise.all([outcome, completed]);
        return result;
      } catch (error) {
        await completed.catch(() => {});
        throw error;
      }
    },
  });
}

function acquireOwner(transaction, owners, journals, batches, journalId, ownerId) {
  return new Promise((resolve, reject) => {
    const ownerRequest = owners.get(journalId);
    ownerRequest.onerror = () => reject(
      ownerRequest.error ?? new Error("reading durability owner failed"),
    );
    ownerRequest.onsuccess = () => {
      try {
        const previousFence = durabilityRevision(ownerRequest.result?.fence ?? "0");
        if (previousFence === MAX_REVISION) {
          try { transaction.abort(); } catch {}
          reject(new RangeError("IndexedDB durability fence overflow"));
          return;
        }
        const fence = durabilityRevision(BigInt(previousFence) + 1n);
        const ownerWrite = requestResult(owners.put({ journalId, ownerId, fence }));
        const journalRead = requestResult(journals.get(journalId));
        const batchesRead = requestResult(batches.index(JOURNAL_INDEX).getAll(journalId));
        Promise.all([ownerWrite, journalRead, batchesRead]).then(
          ([, journal, storedBatches]) => {
            try {
              const revision = durabilityRevision(journal?.revision ?? "0");
              const loadedBatches = storedBatches.map((batch) => ({
                revision: durabilityRevision(batch.revision),
                payload: validatePayload(batch.payload),
              }));
              loadedBatches.sort((left, right) => (
                compareRevisions(left.revision, right.revision)
              ));
              resolve(Object.freeze({
                ownerId,
                fence,
                revision,
                batches: Object.freeze(loadedBatches.map((batch) => Object.freeze(batch))),
              }));
            } catch (error) {
              try { transaction.abort(); } catch {}
              reject(error);
            }
          },
          reject,
        );
      } catch (error) {
        try { transaction.abort(); } catch {}
        reject(error);
      }
    };
  });
}

function compareAndAppend(
  transaction,
  owners,
  journals,
  batches,
  journalId,
  ownerId,
  fence,
  expectedRevision,
  payload,
) {
  return new Promise((resolve, reject) => {
    const ownerRequest = owners.get(journalId);
    ownerRequest.onerror = () => reject(
      ownerRequest.error ?? new Error("reading durability owner failed"),
    );
    ownerRequest.onsuccess = () => {
      try {
        const storedOwner = ownerRequest.result;
        if (
          storedOwner?.ownerId !== ownerId
          || durabilityRevision(storedOwner?.fence ?? "0") !== fence
        ) {
          resolve({ status: "fenced" });
          return;
        }
        const journalRequest = journals.get(journalId);
        journalRequest.onerror = () => reject(
          journalRequest.error ?? new Error("reading durability revision failed"),
        );
        journalRequest.onsuccess = () => {
          try {
            const actualRevision = durabilityRevision(journalRequest.result?.revision ?? "0");
            if (actualRevision !== expectedRevision) {
              resolve({ status: "conflict", actualRevision });
              return;
            }
            if (actualRevision === MAX_REVISION) {
              resolve({
                status: "not_committed",
                message: "IndexedDB durability revision overflow",
              });
              return;
            }
            const revision = durabilityRevision(BigInt(actualRevision) + 1n);
            journals.put({ journalId, revision });
            batches.add({ journalId, revision, payload });
            resolve({ status: "appended", revision });
          } catch (error) {
            try { transaction.abort(); } catch {}
            reject(error);
          }
        };
      } catch (error) {
        try { transaction.abort(); } catch {}
        reject(error);
      }
    };
  });
}

function openDatabase(indexedDb, databaseName, invalidate) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDb.open(databaseName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OWNERS_STORE)) {
        database.createObjectStore(OWNERS_STORE, { keyPath: "journalId" });
      }
      if (!database.objectStoreNames.contains(JOURNALS_STORE)) {
        database.createObjectStore(JOURNALS_STORE, { keyPath: "journalId" });
      }
      if (!database.objectStoreNames.contains(BATCHES_STORE)) {
        const batches = database.createObjectStore(BATCHES_STORE, {
          keyPath: ["journalId", "revision"],
        });
        batches.createIndex(JOURNAL_INDEX, "journalId", { unique: false });
      }
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("opening browser durability failed"));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("opening browser durability was blocked"));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => {
        invalidate();
        database.close();
      };
      database.onclose = () => invalidate();
      resolve(database);
    };
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB durability request failed"));
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("IndexedDB durability transaction failed"),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB durability transaction was aborted"),
    );
  });
}

function validateJournalId(journalId) {
  if (typeof journalId !== "string" || !journalId) {
    throw new TypeError("durability journal ID must be a non-empty string");
  }
}

function validatePayload(payload) {
  if (typeof payload !== "string") {
    throw new TypeError("durability batch payload must be a string");
  }
  return payload;
}

function validateOwnerId(ownerId) {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new TypeError("durability owner ID must be a non-empty string");
  }
  return ownerId;
}

function compareRevisions(left, right) {
  const leftRevision = BigInt(left);
  const rightRevision = BigInt(right);
  return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0;
}
