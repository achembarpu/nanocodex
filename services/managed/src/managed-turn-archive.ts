const VERSION = 1;
const DEFAULT_RECENT_TERMINAL_TURNS = 512;
const MAX_SEAL_RECEIPTS = 32;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export type ManagedTurnReceipt = Readonly<{
  accepted_at: number;
  accepted_cursor: string | null;
  attempt_count: number;
  created_at: number;
  error: string | null;
  id: string;
  input_json: string;
  may_have_inner_operation: number;
  request_hash: string;
  request_key: string | null;
  retry_at: number | null;
  state: "completed" | "cancelled" | "failed";
  terminal_cursor: string | null;
  terminal_json: string;
  updated_at: number;
}>;

type ReceiptEnvelope = Readonly<{
  kind: "managed_turn_receipt";
  receipt: ManagedTurnReceipt;
  version: 1;
}>;

type ArchiveState = {
  archived_bytes: number;
  archived_receipts: number;
  object_count: number;
};

export type ManagedTurnArchiveCapacity = Readonly<{
  archived_bytes: number;
  archived_receipts: number;
  objects: number;
}>;

export type ManagedTurnSealResult = Readonly<{
  archived_bytes: number;
  archived_receipts: number;
  objects: number;
  sealed: boolean;
}>;

/** Immutable terminal receipts kept outside the bounded coordination head. */
export class ManagedTurnArchive {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #recentTerminalTurns: number;
  readonly #storage: DurableObjectStorage;

  constructor(
    storage: DurableObjectStorage,
    bucket: R2Bucket,
    agentStorageId: string,
    recentTerminalTurns = DEFAULT_RECENT_TERMINAL_TURNS,
  ) {
    this.#storage = storage;
    this.#bucket = bucket;
    this.#prefix = `agents/${agentStorageId}/managed-turns/`;
    this.#recentTerminalTurns = Number.isSafeInteger(recentTerminalTurns)
      ? Math.min(4_096, Math.max(1, recentTerminalTurns))
      : DEFAULT_RECENT_TERMINAL_TURNS;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS managed_turn_archive_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        archived_receipts INTEGER NOT NULL DEFAULT 0 CHECK (archived_receipts >= 0),
        archived_bytes INTEGER NOT NULL DEFAULT 0 CHECK (archived_bytes >= 0),
        object_count INTEGER NOT NULL DEFAULT 0 CHECK (object_count >= 0)
      );
      INSERT OR IGNORE INTO managed_turn_archive_state (singleton) VALUES (1);
    `);
  }

  capacity(): ManagedTurnArchiveCapacity {
    const state = this.#state();
    return {
      archived_bytes: state.archived_bytes,
      archived_receipts: state.archived_receipts,
      objects: state.object_count,
    };
  }

  needsSeal(): boolean {
    return this.#terminalCount() > this.#recentTerminalTurns;
  }

  async findById(id: string): Promise<ManagedTurnReceipt | undefined> {
    if (this.#state().archived_receipts === 0) return undefined;
    const receipt = await this.#read(`${this.#prefix}by-id/${await sha256Hex(encoder.encode(id))}.json`);
    if (receipt && receipt.id !== id) {
      throw new Error("managed turn archive ID lookup returned a conflicting receipt");
    }
    return receipt;
  }

  async findByRequestKey(requestKey: string): Promise<ManagedTurnReceipt | undefined> {
    if (this.#state().archived_receipts === 0) return undefined;
    const receipt = await this.#read(
      `${this.#prefix}by-request/${await sha256Hex(encoder.encode(requestKey))}.json`,
    );
    if (receipt && receipt.request_key !== requestKey) {
      throw new Error("managed turn archive request lookup returned a conflicting receipt");
    }
    return receipt;
  }

  async seal(force = false): Promise<ManagedTurnSealResult> {
    const terminalCount = this.#terminalCount();
    const available = Math.max(
      0,
      terminalCount - (force ? Math.min(1, terminalCount) : this.#recentTerminalTurns),
    );
    if (available === 0) return emptySeal();
    const receipts = this.#storage.sql.exec<ManagedTurnReceipt>(
      `${RECEIPT_SELECT}
       WHERE state IN ('completed', 'cancelled', 'failed')
         AND terminal_json IS NOT NULL
       ORDER BY updated_at, created_at, id
       LIMIT ?`,
      Math.min(MAX_SEAL_RECEIPTS, available),
    ).toArray();
    if (receipts.length === 0) return emptySeal();

    const encoded = await Promise.all(receipts.map(async (receipt) => {
      validateReceipt(receipt);
      const body = encoder.encode(JSON.stringify({
        version: VERSION,
        kind: "managed_turn_receipt",
        receipt,
      } satisfies ReceiptEnvelope));
      if (body.byteLength > MAX_RECEIPT_BYTES) {
        throw new Error("managed turn archive receipt exceeds the object boundary");
      }
      const bodyHash = await sha256Hex(body);
      const keys = [
        `${this.#prefix}by-id/${await sha256Hex(encoder.encode(receipt.id))}.json`,
        ...(receipt.request_key === null ? [] : [
          `${this.#prefix}by-request/${await sha256Hex(encoder.encode(receipt.request_key))}.json`,
        ]),
      ];
      await Promise.all(keys.map((key) => this.#putImmutable(key, body, bodyHash)));
      return { bodyBytes: body.byteLength, keys, receipt };
    }));

    this.#storage.transactionSync(() => {
      for (const item of encoded) {
        const retained = this.#storage.sql.exec<ManagedTurnReceipt>(
          `${RECEIPT_SELECT} WHERE id = ?`,
          item.receipt.id,
        ).toArray()[0];
        if (!retained || JSON.stringify(retained) !== JSON.stringify(item.receipt)) {
          throw new Error("managed turn archive receipt changed before commit");
        }
      }
      this.#storage.sql.exec(
        `DELETE FROM managed_turns WHERE id IN (${encoded.map(() => "?").join(",")})`,
        ...encoded.map(({ receipt }) => receipt.id),
      );
      this.#storage.sql.exec(
        `UPDATE managed_turn_archive_state
         SET archived_receipts = archived_receipts + ?,
             archived_bytes = archived_bytes + ?,
             object_count = object_count + ?
         WHERE singleton = 1`,
        encoded.length,
        encoded.reduce((sum, item) => sum + item.bodyBytes * item.keys.length, 0),
        encoded.reduce((sum, item) => sum + item.keys.length, 0),
      );
    });
    return {
      archived_bytes: encoded.reduce((sum, item) => sum + item.bodyBytes * item.keys.length, 0),
      archived_receipts: encoded.length,
      objects: encoded.reduce((sum, item) => sum + item.keys.length, 0),
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
      UPDATE managed_turn_archive_state
      SET archived_receipts = 0, archived_bytes = 0, object_count = 0
      WHERE singleton = 1
    `);
  }

  async #read(key: string): Promise<ManagedTurnReceipt | undefined> {
    const object = await this.#bucket.get(key);
    if (!object) return undefined;
    if (!object.body || object.size > MAX_RECEIPT_BYTES) {
      await object.body?.cancel();
      throw new Error("managed turn archive receipt exceeds the object boundary");
    }
    const body = new Uint8Array(await object.arrayBuffer());
    const expectedHash = object.customMetadata?.sha256;
    if (!expectedHash || object.customMetadata?.kind !== "managed_turn_receipt"
      || object.customMetadata?.version !== String(VERSION)
      || await sha256Hex(body) !== expectedHash) {
      throw new Error("managed turn archive receipt checksum mismatch");
    }
    const envelope = JSON.parse(new TextDecoder().decode(body)) as ReceiptEnvelope;
    if (envelope.version !== VERSION || envelope.kind !== "managed_turn_receipt") {
      throw new Error("managed turn archive receipt envelope is invalid");
    }
    validateReceipt(envelope.receipt);
    return envelope.receipt;
  }

  async #putImmutable(key: string, body: Uint8Array, sha256: string): Promise<void> {
    const stored = await this.#bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: { kind: "managed_turn_receipt", sha256, version: String(VERSION) },
      sha256,
    });
    if (stored) return;
    const existing = await this.#bucket.head(key);
    if (!existing || existing.size !== body.byteLength
      || existing.customMetadata?.sha256 !== sha256
      || existing.customMetadata?.kind !== "managed_turn_receipt") {
      throw new Error("managed turn archive immutable receipt conflicts with existing data");
    }
  }

  #terminalCount(): number {
    return this.#storage.sql.exec<{ rows: number }>(
      "SELECT COUNT(*) AS rows FROM managed_turns WHERE state IN ('completed', 'cancelled', 'failed')",
    ).toArray()[0]?.rows ?? 0;
  }

  #state(): ArchiveState {
    const state = this.#storage.sql.exec<ArchiveState>(
      `SELECT archived_receipts, archived_bytes, object_count
       FROM managed_turn_archive_state WHERE singleton = 1`,
    ).toArray()[0];
    if (!state) throw new Error("managed turn archive state is unavailable");
    return state;
  }
}

const RECEIPT_SELECT = `
  SELECT id, request_key, request_hash, input_json, state,
         CAST(accepted_cursor AS TEXT) AS accepted_cursor,
         terminal_json, CAST(terminal_cursor AS TEXT) AS terminal_cursor,
         error, may_have_inner_operation, attempt_count, retry_at,
         created_at, accepted_at, updated_at
  FROM managed_turns`;

function validateReceipt(value: ManagedTurnReceipt): void {
  if (!value || typeof value !== "object"
    || typeof value.id !== "string" || value.id.length === 0
    || value.id.length > 128
    || typeof value.request_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.request_hash)
    || typeof value.input_json !== "string"
    || (value.request_key !== null
      && (typeof value.request_key !== "string" || value.request_key.length === 0))
    || !["completed", "cancelled", "failed"].includes(value.state)
    || typeof value.terminal_json !== "string" || value.terminal_json.length === 0
    || typeof value.accepted_cursor !== "string" || !/^[1-9][0-9]*$/.test(value.accepted_cursor)
    || typeof value.terminal_cursor !== "string" || !/^[1-9][0-9]*$/.test(value.terminal_cursor)
    || BigInt(value.accepted_cursor) > BigInt(value.terminal_cursor)
    || (value.error !== null && typeof value.error !== "string")
    || (value.may_have_inner_operation !== 0 && value.may_have_inner_operation !== 1)
    || value.retry_at !== null
    || !Number.isSafeInteger(value.created_at) || value.created_at < 0
    || !Number.isSafeInteger(value.accepted_at) || value.accepted_at < value.created_at
    || !Number.isSafeInteger(value.updated_at) || value.updated_at < value.accepted_at
    || !Number.isSafeInteger(value.attempt_count) || value.attempt_count < 0) {
    throw new Error("managed turn archive receipt is invalid");
  }
  JSON.parse(value.input_json);
  const terminal = JSON.parse(value.terminal_json) as { id?: unknown; type?: unknown };
  const expectedType = `turn_${value.state}`;
  if (!terminal || typeof terminal !== "object"
    || terminal.id !== value.id || terminal.type !== expectedType) {
    throw new Error("managed turn archive terminal projection is invalid");
  }
}

function emptySeal(): ManagedTurnSealResult {
  return { archived_bytes: 0, archived_receipts: 0, objects: 0, sealed: false };
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
