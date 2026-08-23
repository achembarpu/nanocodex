const DATABASE_NAME = "nanocodex-local-transcripts-v1";
const DATABASE_VERSION = 1;
const TURNS_STORE = "turns";
const SESSIONS_STORE = "sessions";
const THREAD_ORDER_INDEX = "thread-order";

export const MAX_LOCAL_TRANSCRIPT_TURNS = 100;

export type LocalTranscriptTurn = Readonly<{
  threadId: string;
  turnId: string;
  createdAt: number;
  prompt?: string;
  assistant?: string;
}>;

export type LocalTranscriptLoad = Readonly<{
  initialized: boolean;
  turns: readonly LocalTranscriptTurn[];
}>;

export type LocalTranscriptJournal = Readonly<{
  load(threadId: string): Promise<LocalTranscriptLoad>;
  bootstrap(threadId: string, turns: readonly LocalTranscriptTurn[]): Promise<void>;
  recordPrompt(turn: LocalTranscriptTurn): Promise<void>;
  completeTurn(turn: LocalTranscriptTurn): Promise<void>;
}>;

type StoredTurn = LocalTranscriptTurn & Readonly<{ order: string }>;

/** Browser-owned transcript durability, separate from the model's compactable context. */
export function createLocalTranscriptJournal(options: {
  indexedDB?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
  databaseName?: string;
} = {}): LocalTranscriptJournal {
  const indexedDb = options.indexedDB ?? globalThis.indexedDB;
  const keyRange = options.keyRange ?? globalThis.IDBKeyRange;
  const databaseName = options.databaseName ?? DATABASE_NAME;
  let database: Promise<IDBDatabase> | undefined;

  const open = () => {
    if (!indexedDb || !keyRange) {
      return Promise.reject(new Error("local transcript storage requires IndexedDB"));
    }
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
    async load(threadId) {
      const db = await open();
      const transaction = db.transaction([SESSIONS_STORE, TURNS_STORE], "readonly");
      const completed = transactionCompletion(transaction);
      const initialized = requestResult<{ initialized?: unknown } | undefined>(
        transaction.objectStore(SESSIONS_STORE).get(threadId),
      );
      const range = keyRange.bound([threadId, ""], [threadId, "\uffff"]);
      const turns = recentTurns(
        transaction.objectStore(TURNS_STORE).index(THREAD_ORDER_INDEX),
        range,
        threadId,
      );
      const [session, recent] = await Promise.all([initialized, turns, completed]);
      return Object.freeze({
        initialized: session?.initialized === true,
        turns: Object.freeze(recent),
      });
    },

    async bootstrap(threadId, turns) {
      const db = await open();
      const transaction = db.transaction([SESSIONS_STORE, TURNS_STORE], "readwrite");
      const completed = transactionCompletion(transaction);
      const sessions = transaction.objectStore(SESSIONS_STORE);
      const storedTurns = transaction.objectStore(TURNS_STORE);
      const initialized = new Promise<void>((resolve, reject) => {
        const request = sessions.get(threadId);
        request.onerror = () => reject(request.error ?? new Error("reading transcript bootstrap state failed"));
        request.onsuccess = () => {
          if (request.result?.initialized === true) {
            resolve();
            return;
          }
          const bootstrapTurns = turns.slice(-MAX_LOCAL_TRANSCRIPT_TURNS);
          if (bootstrapTurns.length === 0) {
            markInitialized();
            return;
          }
          let remaining = bootstrapTurns.length;
          for (const turn of bootstrapTurns) {
            const existing = storedTurns.get([turn.threadId, turn.turnId]);
            existing.onerror = () => reject(existing.error ?? new Error("reading transcript bootstrap turn failed"));
            existing.onsuccess = () => {
              if (existing.result !== undefined) {
                finishTurn();
                return;
              }
              const added = storedTurns.add(storedTurn(turn, true));
              added.onerror = () => reject(added.error ?? new Error("writing transcript bootstrap turn failed"));
              added.onsuccess = finishTurn;
            };
          }

          function finishTurn() {
            remaining -= 1;
            if (remaining === 0) markInitialized();
          }

          function markInitialized() {
            const marked = sessions.put({ threadId, initialized: true });
            marked.onerror = () => reject(marked.error ?? new Error("writing transcript bootstrap state failed"));
            marked.onsuccess = () => resolve();
          }
        };
      });
      await Promise.all([initialized, completed]);
    },

    async recordPrompt(turn) {
      const db = await open();
      const transaction = db.transaction(TURNS_STORE, "readwrite");
      const completed = transactionCompletion(transaction);
      transaction.objectStore(TURNS_STORE).add(storedTurn(turn));
      await completed;
    },

    async completeTurn(turn) {
      const db = await open();
      const transaction = db.transaction(TURNS_STORE, "readwrite");
      const completed = transactionCompletion(transaction);
      const turns = transaction.objectStore(TURNS_STORE);
      const updated = new Promise<void>((resolve, reject) => {
        const request = turns.get([turn.threadId, turn.turnId]);
        request.onerror = () => reject(request.error ?? new Error("reading local transcript turn failed"));
        request.onsuccess = () => {
          turns.put(storedTurn({ ...turn, ...request.result, assistant: turn.assistant }));
          resolve();
        };
      });
      await Promise.all([updated, completed]);
    },
  });
}

function openDatabase(
  indexedDb: IDBFactory,
  databaseName: string,
  invalidate: () => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDb.open(databaseName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSIONS_STORE)) {
        database.createObjectStore(SESSIONS_STORE, { keyPath: "threadId" });
      }
      if (!database.objectStoreNames.contains(TURNS_STORE)) {
        const turns = database.createObjectStore(TURNS_STORE, {
          keyPath: ["threadId", "turnId"],
        });
        turns.createIndex(THREAD_ORDER_INDEX, ["threadId", "order"], { unique: false });
      }
    };
    request.onerror = () => rejectOnce(request.error ?? new Error("opening local transcript storage failed"));
    request.onblocked = () => rejectOnce(new Error("opening local transcript storage was blocked"));
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
      resolve(database);
    };
    function rejectOnce(error: unknown) {
      if (settled) return;
      settled = true;
      reject(error);
    }
  });
}

function recentTurns(
  index: IDBIndex,
  range: IDBKeyRange,
  threadId: string,
): Promise<LocalTranscriptTurn[]> {
  return new Promise((resolve, reject) => {
    const turns: LocalTranscriptTurn[] = [];
    let visited = 0;
    const request = index.openCursor(range, "prev");
    request.onerror = () => reject(request.error ?? new Error("reading local transcript failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        turns.reverse();
        resolve(turns);
        return;
      }
      visited += 1;
      const turn = decodeTurn(cursor.value, threadId);
      if (turn) turns.push(turn);
      if (visited >= MAX_LOCAL_TRANSCRIPT_TURNS) {
        turns.reverse();
        resolve(turns);
        return;
      }
      cursor.continue();
    };
  });
}

function storedTurn(turn: LocalTranscriptTurn, bootstrap = false): StoredTurn {
  // A first-run context import must sort before prompts that race with it. The
  // punctuation also keeps the ordering compatible with pre-journal records:
  // bootstrap (!) < legacy timestamp (0-9) < app-owned live turn (~).
  const prefix = bootstrap ? "!" : "~";
  return Object.freeze({
    ...turn,
    order: `${prefix}:${String(turn.createdAt).padStart(16, "0")}:${turn.turnId}`,
  });
}

function decodeTurn(value: unknown, threadId: string): LocalTranscriptTurn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const turn = value as Partial<LocalTranscriptTurn>;
  if (turn.threadId !== threadId || typeof turn.turnId !== "string" || !turn.turnId
    || typeof turn.createdAt !== "number" || !Number.isFinite(turn.createdAt)
    || (turn.prompt !== undefined && typeof turn.prompt !== "string")
    || (turn.assistant !== undefined && typeof turn.assistant !== "string")) return undefined;
  return Object.freeze({
    threadId,
    turnId: turn.turnId,
    createdAt: turn.createdAt,
    ...(turn.prompt === undefined ? {} : { prompt: turn.prompt }),
    ...(turn.assistant === undefined ? {} : { assistant: turn.assistant }),
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("local transcript request failed"));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("local transcript transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("local transcript transaction aborted"));
  });
}
