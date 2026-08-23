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
  await assert.rejects(
    store.append("thread", { expectedRevision: "01", payload: "invalid" }),
    /unsigned 64-bit decimal string/,
  );
  await assert.rejects(
    store.append("thread", { expectedRevision: "10", payload: new Uint8Array() }),
    /payload must be a string/,
  );
});

test("IndexedDB durability serializes atomic compare-and-append transactions", async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createIndexedDbDurabilityStore({ indexedDB, databaseName: "atomic" });
  const results = await Promise.all([
    store.append("thread", { expectedRevision: "0", payload: "left" }),
    store.append("thread", { expectedRevision: "0", payload: "right" }),
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
    store.append("thread", { expectedRevision: "1", payload: "rolled back" }),
    /injected batch failure/,
  );
  assert.deepEqual(await store.load("thread"), journal);
});

test("IndexedDB durability reports u64 overflow without committing", async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createIndexedDbDurabilityStore({ indexedDB, databaseName: "overflow" });
  const maximum = "18446744073709551615";
  await store.load("thread");
  indexedDB.seed("overflow", "thread", maximum, [{ revision: maximum, payload: "last" }]);

  assert.deepEqual(
    await store.append("thread", { expectedRevision: maximum, payload: "never" }),
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

test("IndexedDB durability has no browser-global import-time dependency", () => {
  assert.throws(() => createIndexedDbDurabilityStore(), /requires IndexedDB/);
});

function createFakeIndexedDb() {
  const databases = new Map();
  return {
    open(name) {
      const request = fakeRequest();
      queueMicrotask(() => {
        let database = databases.get(name);
        if (!database) {
          database = new FakeDatabase();
          databases.set(name, database);
          request.result = database;
          request.onupgradeneeded?.();
        } else {
          request.result = database;
        }
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
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
  };
}

class FakeDatabase {
  constructor() {
    this.stores = new Map();
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
    return new FakeTransaction(this, names, mode);
  }

  close() {}
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
