const VERSION = 1;
const DEFAULT_RECENT_OPERATIONS = 512;
const MAX_SEAL_RECEIPTS = 32;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export type ManagedRealtimeReceipt = Readonly<{
  created_at: number;
  kind: "start" | "delegate" | "stop";
  operation_id: string;
  request_hash: string;
  response_json: string;
  state: "completed";
  updated_at: number;
  voice_session_id: string;
}>;

type ReceiptEnvelope = Readonly<{
  kind: "managed_realtime_receipt";
  receipt: ManagedRealtimeReceipt;
  version: 1;
}>;

type ArchiveState = {
  archived_bytes: number;
  archived_receipts: number;
  object_count: number;
};

export type ManagedRealtimeArchiveCapacity = Readonly<{
  archived_bytes: number;
  archived_receipts: number;
  objects: number;
}>;

export type ManagedRealtimeSealResult = ManagedRealtimeArchiveCapacity & Readonly<{
  sealed: boolean;
}>;

/** Immutable exact-replay receipts outside the bounded realtime coordination head. */
export class ManagedRealtimeArchive {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #recentOperations: number;
  readonly #storage: DurableObjectStorage;

  constructor(
    storage: DurableObjectStorage,
    bucket: R2Bucket,
    agentStorageId: string,
    recentOperations = DEFAULT_RECENT_OPERATIONS,
  ) {
    this.#storage = storage;
    this.#bucket = bucket;
    this.#prefix = `agents/${agentStorageId}/managed-realtime/`;
    this.#recentOperations = Number.isSafeInteger(recentOperations)
      ? Math.min(4_096, Math.max(1, recentOperations))
      : DEFAULT_RECENT_OPERATIONS;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS managed_realtime_archive_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        archived_receipts INTEGER NOT NULL DEFAULT 0 CHECK (archived_receipts >= 0),
        archived_bytes INTEGER NOT NULL DEFAULT 0 CHECK (archived_bytes >= 0),
        object_count INTEGER NOT NULL DEFAULT 0 CHECK (object_count >= 0)
      );
      INSERT OR IGNORE INTO managed_realtime_archive_state (singleton) VALUES (1);
    `);
  }

  capacity(): ManagedRealtimeArchiveCapacity {
    const state = this.#state();
    return {
      archived_bytes: state.archived_bytes,
      archived_receipts: state.archived_receipts,
      objects: state.object_count,
    };
  }

  needsSeal(): boolean {
    return this.#completedCount() > this.#recentOperations;
  }

  async find(
    voiceSessionId: string,
    operationId: string,
  ): Promise<ManagedRealtimeReceipt | undefined> {
    if (this.#state().archived_receipts === 0) return undefined;
    const identity = `${voiceSessionId}\n${operationId}`;
    const key = `${this.#prefix}by-id/${await sha256Hex(encoder.encode(identity))}.json`;
    const object = await this.#bucket.get(key);
    if (!object) return undefined;
    if (!object.body || object.size > MAX_RECEIPT_BYTES) {
      await object.body?.cancel();
      throw new Error("managed realtime archive receipt exceeds the object boundary");
    }
    const body = new Uint8Array(await object.arrayBuffer());
    const expectedHash = object.customMetadata?.sha256;
    if (!expectedHash || object.customMetadata?.kind !== "managed_realtime_receipt"
      || object.customMetadata?.version !== String(VERSION)
      || await sha256Hex(body) !== expectedHash) {
      throw new Error("managed realtime archive receipt checksum mismatch");
    }
    const envelope = JSON.parse(new TextDecoder().decode(body)) as ReceiptEnvelope;
    if (envelope.version !== VERSION || envelope.kind !== "managed_realtime_receipt") {
      throw new Error("managed realtime archive receipt envelope is invalid");
    }
    validateReceipt(envelope.receipt);
    if (envelope.receipt.voice_session_id !== voiceSessionId
      || envelope.receipt.operation_id !== operationId) {
      throw new Error("managed realtime archive lookup returned a conflicting receipt");
    }
    return envelope.receipt;
  }

  async seal(force = false): Promise<ManagedRealtimeSealResult> {
    const count = this.#completedCount();
    const available = Math.max(
      0,
      count - (force ? Math.min(1, count) : this.#recentOperations),
    );
    if (available === 0) return emptySeal();
    const receipts = this.#storage.sql.exec<ManagedRealtimeReceipt>(
      `${RECEIPT_SELECT}
       WHERE state = 'completed' AND response_json IS NOT NULL
       ORDER BY updated_at, created_at, voice_session_id, operation_id
       LIMIT ?`,
      Math.min(MAX_SEAL_RECEIPTS, available),
    ).toArray();
    const encoded = await Promise.all(receipts.map(async (receipt) => {
      validateReceipt(receipt);
      const body = encoder.encode(JSON.stringify({
        version: VERSION,
        kind: "managed_realtime_receipt",
        receipt,
      } satisfies ReceiptEnvelope));
      if (body.byteLength > MAX_RECEIPT_BYTES) {
        throw new Error("managed realtime archive receipt exceeds the object boundary");
      }
      const bodyHash = await sha256Hex(body);
      const identity = `${receipt.voice_session_id}\n${receipt.operation_id}`;
      const key = `${this.#prefix}by-id/${await sha256Hex(encoder.encode(identity))}.json`;
      await this.#putImmutable(key, body, bodyHash);
      return { bodyBytes: body.byteLength, receipt };
    }));
    if (encoded.length === 0) return emptySeal();

    this.#storage.transactionSync(() => {
      for (const item of encoded) {
        const retained = this.#storage.sql.exec<ManagedRealtimeReceipt>(
          `${RECEIPT_SELECT} WHERE voice_session_id = ? AND operation_id = ?`,
          item.receipt.voice_session_id,
          item.receipt.operation_id,
        ).toArray()[0];
        if (!retained || JSON.stringify(retained) !== JSON.stringify(item.receipt)) {
          throw new Error("managed realtime archive receipt changed before commit");
        }
      }
      for (const { receipt } of encoded) {
        this.#storage.sql.exec(
          `DELETE FROM managed_realtime_operations
           WHERE voice_session_id = ? AND operation_id = ? AND state = 'completed'`,
          receipt.voice_session_id,
          receipt.operation_id,
        );
      }
      this.#storage.sql.exec(
        `UPDATE managed_realtime_archive_state
         SET archived_receipts = archived_receipts + ?,
             archived_bytes = archived_bytes + ?,
             object_count = object_count + ?
         WHERE singleton = 1`,
        encoded.length,
        encoded.reduce((sum, item) => sum + item.bodyBytes, 0),
        encoded.length,
      );
    });
    return {
      archived_bytes: encoded.reduce((sum, item) => sum + item.bodyBytes, 0),
      archived_receipts: encoded.length,
      objects: encoded.length,
      sealed: true,
    };
  }

  async deleteAll(): Promise<number> {
    let deleted = 0;
    while (true) {
      const listed = await this.#bucket.list({ prefix: this.#prefix, limit: 1_000 });
      const keys = listed.objects.map(({ key }) => key);
      if (keys.length === 0) return deleted;
      await this.#bucket.delete(keys);
      deleted += keys.length;
    }
  }

  clearLocalState(): void {
    this.#storage.sql.exec(`
      UPDATE managed_realtime_archive_state
      SET archived_receipts = 0, archived_bytes = 0, object_count = 0
      WHERE singleton = 1
    `);
  }

  async #putImmutable(key: string, body: Uint8Array, sha256: string): Promise<void> {
    const stored = await this.#bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: { kind: "managed_realtime_receipt", sha256, version: String(VERSION) },
      sha256,
    });
    if (stored) return;
    const existing = await this.#bucket.head(key);
    if (!existing || existing.size !== body.byteLength
      || existing.customMetadata?.sha256 !== sha256
      || existing.customMetadata?.kind !== "managed_realtime_receipt") {
      throw new Error("managed realtime archive immutable receipt conflicts with existing data");
    }
  }

  #completedCount(): number {
    return this.#storage.sql.exec<{ rows: number }>(
      "SELECT COUNT(*) AS rows FROM managed_realtime_operations WHERE state = 'completed'",
    ).toArray()[0]?.rows ?? 0;
  }

  #state(): ArchiveState {
    const state = this.#storage.sql.exec<ArchiveState>(
      `SELECT archived_receipts, archived_bytes, object_count
       FROM managed_realtime_archive_state WHERE singleton = 1`,
    ).toArray()[0];
    if (!state) throw new Error("managed realtime archive state is unavailable");
    return state;
  }
}

const RECEIPT_SELECT = `
  SELECT voice_session_id, operation_id, kind, request_hash, state,
         response_json, created_at, updated_at
  FROM managed_realtime_operations`;

function validateReceipt(value: ManagedRealtimeReceipt): void {
  if (!value || typeof value !== "object"
    || typeof value.voice_session_id !== "string" || value.voice_session_id.length === 0
    || typeof value.operation_id !== "string" || value.operation_id.length === 0
    || !["start", "delegate", "stop"].includes(value.kind)
    || typeof value.request_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.request_hash)
    || value.state !== "completed"
    || typeof value.response_json !== "string" || value.response_json.length === 0
    || !Number.isSafeInteger(value.created_at) || value.created_at < 0
    || !Number.isSafeInteger(value.updated_at) || value.updated_at < value.created_at) {
    throw new Error("managed realtime archive receipt is invalid");
  }
  JSON.parse(value.response_json);
}

function emptySeal(): ManagedRealtimeSealResult {
  return { archived_bytes: 0, archived_receipts: 0, objects: 0, sealed: false };
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
