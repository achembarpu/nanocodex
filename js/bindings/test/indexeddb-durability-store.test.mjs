import assert from "node:assert/strict";
import { test } from "node:test";

import { createIndexedDbDurabilityStore } from "../browser/indexeddb-durability-store.mjs";

test("IndexedDB durability validates revisions and loads numerically ordered batches", async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createIndexedDbDurabilityStore({ indexedDB, databaseName: "ordered" });

  assert.deepEqual(await store.load("thread"), { revision: "0", batches: [] });
  indexedDB.seed("ordered", "thread", "10", [
    { revision: "10", payload: "ten" },
    { revision: "2", payload: "two" },
    { revision: "1", payload: "one" },
  ]);
  assert.deepEqual(await store.load("thread"), {
    revision: "10",
    batches: [
      { revision: "1", payload: "one" },
      { revision: "2", payload: "two" },
      { revision: "10", payload: "ten" },
    ],
  });
  const owner = await store.acquire("thread", { ownerId: "owner-1" });
  await assert.rejects(
    store.append("thread", {
      ownerId: owner.ownerId,
      fence: owner.fence,
      expectedRevision: "01",
      payload: "invalid",
    }),
    /unsigned 64-bit decimal string/,
  );
  await assert.rejects(
    store.append("thread", {
      ownerId: owner.ownerId,
      fence: owner.fence,
      expectedRevision: "10",
      payload: new Uint8Array(),
    }),
    /payload must be a string/,
  );
});

test("IndexedDB durability serializes atomic compare-and-append transactions", async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createIndexedDbDurabilityStore({ indexedDB, databaseName: "atomic" });
  const owner = await store.acquire("thread", { ownerId: "owner-1" });
  const results = await Promise.all([
    store.append("thread", { ...owner, expectedRevision: "0", payload: "left" }),
    store.append("thread", { ...owner, expectedRevision: "0", payload: "right" }),
  ]);

  assert.equal(results.filter(({ status }) => status === "appended").length, 1);
  assert.deepEqual(results.find(({ status }) => status === "conflict"), {
    status: "conflict",
    actualRevision: "1",
  });
  const journal = await store.load("thread");
  assert.equal(journal.revision, "1");
  assert.equal(journal.batches.length, 1);

  indexedDB.failNextBatchAdd("atomic");
  await assert.rejects(
    store.append("thread", { ...owner, expectedRevision: "1", payload: "rolled back" }),
    /injected batch failure/,
  );
  assert.deepEqual(await store.load("thread"), journal);

  indexedDB.resetContent("atomic", "thread");
  const replacement = await store.acquire("thread", { ownerId: "owner-2" });
  assert.deepEqual(replacement, {
    ownerId: "owner-2",
    fence: "2",
    revision: "0",
    batches: [],
  });
  assert.deepEqual(
    await store.append("thread", { ...owner, expectedRevision: "0", payload: "stale" }),
    { status: "fenced" },
  );
});

test("IndexedDB durability atomically increments concurrent owner acquisitions", async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createIndexedDbDurabilityStore({ indexedDB, databaseName: "owners" });
  const [first, second] = await Promise.all([
    store.acquire("thread", { ownerId: "owner-1" }),
    store.acquire("thread", { ownerId: "owner-2" }),
  ]);

  assert.equal(first.fence, "1");
  assert.equal(second.fence, "2");
  assert.deepEqual(
    await store.append("thread", { ...first, expectedRevision: "99", payload: "stale" }),
    { status: "fenced" },
  );
  assert.deepEqual(
    await store.append("thread", { ...second, expectedRevision: "0", payload: "current" }),
    { status: "appended", revision: "1" },
  );
});

test("IndexedDB durability reports u64 overflow without committing", async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createIndexedDbDurabilityStore({ indexedDB, databaseName: "overflow" });
  const maximum = "18446744073709551615";
  await store.load("thread");
  indexedDB.seed("overflow", "thread", maximum, [{ revision: maximum, payload: "last" }]);
  const owner = await store.acquire("thread", { ownerId: "owner" });

  assert.deepEqual(
    await store.append("thread", { ...owner, expectedRevision: maximum, payload: "never" }),
    {
      status: "not_committed",
      message: "IndexedDB durability revision overflow",
    },
  );
  assert.deepEqual(await store.load("thread"), {
    revision: maximum,
    batches: [{ revision: maximum, payload: "last" }],
  });
});

test("IndexedDB durability upgrades v1 databases with a separate v2 owner store", async () => {
  const indexedDB = createFakeIndexedDb();
  indexedDB.seedVersionOne("upgrade", "thread", "1", [
    { revision: "1", payload: "retained" },
  ]);
  const store = createIndexedDbDurabilityStore({ indexedDB, databaseName: "upgrade" });

  assert.deepEqual(await store.acquire("thread", { ownerId: "owner" }), {
    ownerId: "owner",
    fence: "1",
    revision: "1",
    batches: [{ revision: "1", payload: "retained" }],
  });
  assert.equal(indexedDB.version("upgrade"), 2);
});

test("IndexedDB durability has no browser-global import-time dependency", () => {
  assert.throws(() => createIndexedDbDurabilityStore(), /requires IndexedDB/);
});

test("IndexedDB durability retries failed opens and reopens retained journals after close", async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createIndexedDbDurabilityStore({ indexedDB, databaseName: "reopen" });
  indexedDB.failNextOpen("reopen");

  await assert.rejects(store.load("thread"), /injected open failure/);
  const owner = await store.acquire("thread", { ownerId: "owner" });
  assert.deepEqual(
    await store.append("thread", { ...owner, expectedRevision: "0", payload: "retained" }),
    { status: "appended", revision: "1" },
  );
  assert.equal(indexedDB.openCount("reopen"), 2, "a rejected open is not cached");

  indexedDB.triggerVersionChange("reopen");
  assert.deepEqual(await store.load("thread"), {
    revision: "1",
    batches: [{ revision: "1", payload: "retained" }],
  });
  assert.equal(indexedDB.openCount("reopen"), 3, "a closed connection is not cached");

  indexedDB.triggerAbnormalClose("reopen");
  assert.deepEqual(await store.load("thread"), {
    revision: "1",
    batches: [{ revision: "1", payload: "retained" }],
  });
  assert.equal(indexedDB.openCount("reopen"), 4, "an abnormal close is not cached");
});

function createFakeIndexedDb() {
  const databases = new Map();
  const failedOpens = new Set();
  const openCounts = new Map();
  return {
    open(name, version) {
      const request = fakeRequest();
      openCounts.set(name, (openCounts.get(name) ?? 0) + 1);
      queueMicrotask(() => {
        if (failedOpens.delete(name)) {
          request.error = new Error("injected open failure");
          request.onerror?.();
          return;
        }
        let database = databases.get(name);
        let upgrade = false;
        if (!database) {
          database = new FakeDatabase(version);
          databases.set(name, database);
          upgrade = true;
        } else if (version > database.version) {
          database.version = version;
          upgrade = true;
        }
        database.closed = false;
        request.result = database;
        if (upgrade) {
          request.onupgradeneeded?.();
        }
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
    failNextOpen(name) {
      failedOpens.add(name);
    },
    openCount(name) {
      return openCounts.get(name) ?? 0;
    },
    triggerVersionChange(name) {
      databases.get(name).onversionchange?.();
    },
    triggerAbnormalClose(name) {
      const database = databases.get(name);
      database.closed = true;
      database.onclose?.();
    },
    version(name) {
      return databases.get(name)?.version;
    },
    seedVersionOne(name, journalId, revision, batches) {
      const database = new FakeDatabase(1);
      database.createObjectStore("journals", { keyPath: "journalId" });
      const batchStore = database.createObjectStore("batches", {
        keyPath: ["journalId", "revision"],
      });
      batchStore.createIndex("journalId", "journalId");
      databases.set(name, database);
      this.seed(name, journalId, revision, batches);
    },
    seed(name, journalId, revision, batches) {
      const database = databases.get(name);
      if (!database) throw new Error(`database ${name} has not been opened`);
      database.stores.get("journals").records.set(journalId, { journalId, revision });
      const records = database.stores.get("batches").records;
      for (const batch of batches) {
        records.set(JSON.stringify([journalId, batch.revision]), { journalId, ...batch });
      }
    },
    failNextBatchAdd(name) {
      databases.get(name).failNextBatchAdd = true;
    },
    resetContent(name, journalId) {
      const database = databases.get(name);
      database.stores.get("journals").records.delete(journalId);
      const records = database.stores.get("batches").records;
      for (const [key, batch] of records) {
        if (batch.journalId === journalId) records.delete(key);
      }
    },
  };
}

class FakeDatabase {
  constructor(version) {
    this.version = version;
    this.stores = new Map();
    this.closed = false;
    this.failNextBatchAdd = false;
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
    this.writeTail = Promise.resolve();
  }

  createObjectStore(name, { keyPath }) {
    const definition = { keyPath, indexes: new Map(), records: new Map() };
    this.stores.set(name, definition);
    return {
      createIndex: (indexName, indexKeyPath) => {
        definition.indexes.set(indexName, indexKeyPath);
      },
    };
  }

  transaction(names, mode) {
    if (this.closed) throw new Error("database connection is closed");
    return new FakeTransaction(this, names, mode);
  }

  close() { this.closed = true; }
}

class FakeTransaction {
  constructor(database, names, mode) {
    this.database = database;
    this.mode = mode;
    this.error = null;
    this.pending = 0;
    this.finished = false;
    let release;
    this.released = new Promise((resolve) => { release = resolve; });
    this.release = release;
    const predecessor = database.writeTail;
    if (mode === "readwrite") database.writeTail = predecessor.then(() => this.released);
    this.ready = (mode === "readwrite" ? predecessor : database.writeTail).then(() => {
      this.views = new Map(names.map((name) => [name, cloneStore(database.stores.get(name))]));
    });
  }

  objectStore(name) {
    return new FakeObjectStore(this, name);
  }

  enqueue(operation) {
    const request = fakeRequest();
    this.pending += 1;
    this.ready.then(() => {
      if (this.finished) return;
      try {
        request.result = operation();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        this.error = error;
        request.onerror?.();
        this.abort();
        return;
      }
      this.pending -= 1;
      queueMicrotask(() => this.completeIfIdle());
    });
    return request;
  }

  completeIfIdle() {
    if (this.finished || this.pending !== 0) return;
    this.finished = true;
    if (this.mode === "readwrite") {
      for (const [name, view] of this.views) this.database.stores.set(name, view);
    }
    this.release();
    this.oncomplete?.();
  }

  abort() {
    if (this.finished) return;
    this.finished = true;
    this.release();
    this.onerror?.();
    this.onabort?.();
  }
}

class FakeObjectStore {
  constructor(transaction, name) {
    this.transaction = transaction;
    this.name = name;
  }

  get(key) {
    return this.transaction.enqueue(() => clone(this.definition.records.get(serializeKey(key))));
  }

  put(value) {
    return this.transaction.enqueue(() => {
      this.definition.records.set(recordKey(this.definition.keyPath, value), clone(value));
      return clone(value);
    });
  }

  add(value) {
    return this.transaction.enqueue(() => {
      if (this.name === "batches" && this.transaction.database.failNextBatchAdd) {
        this.transaction.database.failNextBatchAdd = false;
        throw new Error("injected batch failure");
      }
      const key = recordKey(this.definition.keyPath, value);
      if (this.definition.records.has(key)) throw new Error("duplicate key");
      this.definition.records.set(key, clone(value));
      return clone(value);
    });
  }

  index(name) {
    return {
      getAll: (key) => this.transaction.enqueue(() => {
        const keyPath = this.definition.indexes.get(name);
        return [...this.definition.records.values()]
          .filter((value) => value[keyPath] === key)
          .map(clone);
      }),
    };
  }

  get definition() {
    return this.transaction.views.get(this.name);
  }
}

function cloneStore(store) {
  return {
    keyPath: store.keyPath,
    indexes: new Map(store.indexes),
    records: new Map([...store.records].map(([key, value]) => [key, clone(value)])),
  };
}

function fakeRequest() {
  return { error: null, result: undefined };
}

function recordKey(keyPath, value) {
  return serializeKey(Array.isArray(keyPath) ? keyPath.map((key) => value[key]) : value[keyPath]);
}

function serializeKey(key) {
  return Array.isArray(key) ? JSON.stringify(key) : key;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
