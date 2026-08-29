import {
  HOSTED_TOOL_CALL_TIMEOUT_MS,
  HOSTED_TOOLS_LEASE_MS,
  MAX_HOSTED_TOOL_OUTPUT_BYTES,
  HostedToolsProtocolError,
  parseHostedToolsHostFrame,
  parseHostedToolsManagedFrame,
  type HostedToolCallOutcome,
  type HostedToolCatalogEntry,
  type HostedToolsHostFrame,
  type HostedToolsManagedFrame,
} from "./hosted-tools-protocol";

const SOCKET_TAG = "hosted-tools";
const DEFAULT_MAX_IN_FLIGHT = 64;
const MAX_RETAINED_RECEIPTS = 512;
const MAX_CALLS_PER_GENERATION = 512;
const TOOL_RESULT = Symbol.for("nanocodex.toolResult");
const encoder = new TextEncoder();

/**
 * Marks the one case where an attached source is known to be absent before a
 * durable admission. The unified ToolRouter may then select the exact
 * same-name cloud contract. It must never infer this from an outcome message:
 * every other unavailable, cancellation, timeout, and ambiguous outcome is
 * pinned to the attached source and is final.
 */
export const HOSTED_TOOLS_PRE_ADMISSION_UNAVAILABLE = Symbol.for(
  "nanocodex.tool.preDispatchUnavailable",
);

type HostedToolsCallState =
  | "admitted"
  | "dispatched"
  | "completed"
  | "unavailable"
  | "ambiguous"
  | "cancelled";

type HostedToolsStateRow = {
  generation: number;
  host_id: string | null;
  lease_id: string | null;
  lease_expires_at: number;
  catalog_json: string | null;
};

type HostedToolsCallRow = {
  call_id: string;
  session_id: string;
  source_call_id: string;
  host_id: string;
  lease_id: string;
  generation: number;
  model: string;
  name: string;
  input_json: string;
  output_token_budget: number;
  output_byte_budget: number;
  deadline_at: number;
  cancel_requested: number;
  state: HostedToolsCallState;
  result_json: string | null;
  receipt_json: string | null;
};

type HostedToolsSocketAttachment = {
  kind: typeof SOCKET_TAG;
  sessionId: string;
  allowedMcpIds?: readonly string[];
  leaseId?: string;
  generation?: number;
  active?: true;
  draining?: true;
};

type PendingCall = {
  leaseId: string;
  generation: number;
  deadlineAt: number;
  promise: Promise<HostedToolCallOutcome>;
  resolve(outcome: HostedToolCallOutcome): void;
  timeout?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
};

export type HostedToolsBrokerContext = Pick<
  DurableObjectState,
  "acceptWebSocket" | "getWebSockets" | "storage"
>;

export type HostedToolsProviderDefinition = Readonly<HostedToolCatalogEntry>;

export type HostedToolsInvokeRequest = Readonly<{
  sessionId: string;
  callId: string;
  model: string;
  input: Record<string, unknown> | string;
  outputTokenBudget: number;
  outputByteBudget?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}>;

export type HostedToolsPreparedTool = Readonly<{
  entry: HostedToolCatalogEntry;
  invoke(request: HostedToolsInvokeRequest): Promise<HostedToolsInvocationOutcome>;
}>;

type HostedToolsCatalogBinding = Readonly<{
  hostId: string;
  leaseId: string;
  generation: number;
  entry: HostedToolCatalogEntry;
}>;

export type HostedToolsCodeDefinition = HostedToolCatalogEntry["definition"] & {
  defer_loading: true;
};

export type HostedToolsCatalogCandidate = Readonly<
  Omit<HostedToolCatalogEntry, "definition"> & { definition: HostedToolsCodeDefinition }
>;

export type HostedToolsCatalogValidator = (
  definitions: readonly HostedToolsCatalogCandidate[],
) => true;

export type HostedToolsCodeTool = Readonly<{
  name: string;
  parallelSafe: boolean;
  handler(
    input: unknown,
    context: { sessionId: string; callId: string; model?: string; signal?: AbortSignal },
  ): Promise<unknown>;
}>;

export interface HostedToolsDynamicProvider {
  definitions(): readonly HostedToolsCodeDefinition[];
  resolve(name: string): HostedToolsCodeTool | undefined;
  /** Installed by the owning ToolRouter to reject non-parity catalogs before ACK. */
  setCatalogValidator(validator: HostedToolsCatalogValidator | undefined): void;
}

/** Injectable durable call ledger boundary; the production default is Durable Object SQLite. */
export interface HostedToolsBrokerPersistence {
  initialize(now: number): HostedToolsStateRow | undefined;
  transaction<T>(callback: () => T): T;
  state(): HostedToolsStateRow;
  replaceHost(row: HostedToolsStateRow): void;
  clearHost(leaseId: string, generation: number): void;
  clearCatalog(leaseId: string, generation: number): void;
  call(callId: string): HostedToolsCallRow | undefined;
  callBySource(sessionId: string, sourceCallId: string): HostedToolsCallRow | undefined;
  insertCall(row: HostedToolsCallRow, now: number): void;
  markCancelRequested(callId: string, now: number): HostedToolsCallRow | undefined;
  transitionCall(
    callId: string,
    from: readonly HostedToolsCallState[],
    state: HostedToolsCallState,
    resultJson: string,
    now: number,
  ): HostedToolsCallRow | undefined;
  recordLateReceipt(callId: string, receiptJson: string, now: number): HostedToolsCallRow | undefined;
  markGenerationAmbiguous(leaseId: string, generation: number, resultJson: string, now: number): void;
  activeCallCount(leaseId: string, generation: number): number;
  generationCallCount(leaseId: string, generation: number): number;
  pruneReceipts(activeLeaseId: string | null, activeGeneration: number, limit: number): void;
}

export type HostedToolsBrokerOptions = Readonly<{
  now?: () => number;
  randomUUID?: () => string;
  maxInFlight?: number;
  maxCallsPerGeneration?: number;
  persistence?: HostedToolsBrokerPersistence;
  onCatalogChanged?: (definitions: readonly HostedToolsProviderDefinition[]) => void;
  providerAllowed?: (provider: string) => boolean;
}>;

/** Owns the reverse tool attachment for one agent Durable Object. */
export class HostedToolsBroker {
  readonly #provider: HostedToolsDynamicProvider;
  readonly #pending = new Map<string, PendingCall>();
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #maxInFlight: number;
  readonly #maxCallsPerGeneration: number;
  readonly #persistence: HostedToolsBrokerPersistence;
  readonly #onCatalogChanged?: (definitions: readonly HostedToolsProviderDefinition[]) => void;
  readonly #providerAllowed: (provider: string) => boolean;
  #catalogValidator?: HostedToolsCatalogValidator;
  #nextCandidateGeneration: number;

  constructor(
    readonly context: HostedToolsBrokerContext,
    options: HostedToolsBrokerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    if (!Number.isSafeInteger(this.#maxInFlight) || this.#maxInFlight < 1
      || this.#maxInFlight > DEFAULT_MAX_IN_FLIGHT) {
      throw new TypeError(`maxInFlight must be an integer from 1 through ${DEFAULT_MAX_IN_FLIGHT}`);
    }
    this.#maxCallsPerGeneration = options.maxCallsPerGeneration ?? MAX_CALLS_PER_GENERATION;
    if (!Number.isSafeInteger(this.#maxCallsPerGeneration) || this.#maxCallsPerGeneration < 1
      || this.#maxCallsPerGeneration > MAX_CALLS_PER_GENERATION) {
      throw new TypeError(`maxCallsPerGeneration must be an integer from 1 through ${MAX_CALLS_PER_GENERATION}`);
    }
    this.#persistence = options.persistence ?? new SqlHostedToolsPersistence(context.storage);
    this.#onCatalogChanged = options.onCatalogChanged;
    this.#providerAllowed = options.providerAllowed ?? (() => true);
    const retired = this.#persistence.initialize(this.#now());
    this.#nextCandidateGeneration = this.#persistence.state().generation;
    for (const socket of this.context.getWebSockets(SOCKET_TAG)) {
      const generation = this.#attachment(socket)?.generation;
      if (generation !== undefined) this.#nextCandidateGeneration = Math.max(this.#nextCandidateGeneration, generation);
    }
    if (retired?.lease_id) {
      for (const socket of this.context.getWebSockets(SOCKET_TAG)) {
        const attachment = this.#attachment(socket);
        if (attachment?.leaseId !== retired.lease_id
          || attachment.generation !== retired.generation) continue;
        closeSocket(socket, 1012, "Hosted Tools owner restarted");
      }
    }
    this.#provider = Object.freeze({
      // ToolRouter owns the one aggregate tool_search. This provider exposes
      // only the current attached definitions, which stay deferred and can be
      // overlaid onto exact cloud contracts by that router.
      definitions: () => this.#definitions()
        .filter((binding) => this.#providerAllowed(binding.provider))
        .map((binding) => Object.freeze({
        ...binding.definition,
        defer_loading: true as const,
      })),
      resolve: (name: string) => {
        const prepared = this.#resolve(name);
        if (!prepared || !this.#providerAllowed(prepared.entry.provider)) return undefined;
        return Object.freeze({
          name,
          parallelSafe: prepared.entry.parallel_safe,
          provider: prepared.entry.provider,
          remoteName: prepared.entry.remote_name,
          summary: prepared.entry.summary,
          timeoutMs: prepared.entry.timeout_ms,
          handler: async (
            input: unknown,
            context: { sessionId: string; callId: string; model?: string; signal?: AbortSignal },
          ) => {
            if (!this.#providerAllowed(prepared.entry.provider)) {
              return toolResult("Hosted tool provider is outside the active grant", {
                status: "unavailable",
                message: "Hosted tool provider is outside the active grant",
              }, false, null);
            }
            const outcome = await prepared.invoke({
              sessionId: context.sessionId,
              callId: context.callId,
              model: context.model ?? "unknown",
              input: input as Record<string, unknown> | string,
              outputTokenBudget: 10_000,
              signal: context.signal,
            });
            if (outcome.status === "completed") return wireToolResult(outcome.output);
            const result = toolResult(outcome.message, outcome, false, null);
            return outcome[HOSTED_TOOLS_PRE_ADMISSION_UNAVAILABLE] === true
              ? Object.freeze({
                  ...(result as Record<PropertyKey, unknown>),
                  [HOSTED_TOOLS_PRE_ADMISSION_UNAVAILABLE]: true,
                })
              : result;
          },
        });
      },
      setCatalogValidator: (validator: HostedToolsCatalogValidator | undefined) => {
        this.#catalogValidator = validator;
      },
    });
  }

  owns(socket: WebSocket): boolean { return this.handles(socket); }

  async message(socket: WebSocket, message: string): Promise<void> {
    await this.webSocketMessage(socket, message);
  }

  close(socket: WebSocket, reason: string): void {
    if (this.handles(socket)) this.#retire(socket, reason);
  }

  shutdown(reason: string): void {
    const sockets = this.context.getWebSockets(SOCKET_TAG);
    for (const socket of sockets) this.#fence(socket, reason);
    if (sockets.length === 0) this.#retireState(this.#persistence.state(), reason);
  }

  isReady(): boolean { return this.#definitions().length > 0; }

  provider(): HostedToolsDynamicProvider { return this.#provider; }

  upgrade(sessionId: string, allowedMcpIds?: readonly string[]): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({
      kind: SOCKET_TAG,
      sessionId,
      ...(allowedMcpIds === undefined ? {} : { allowedMcpIds: [...allowedMcpIds] }),
    } satisfies HostedToolsSocketAttachment);
    this.context.acceptWebSocket(server, [SOCKET_TAG]);
    return new Response(null, { status: 101, webSocket: client });
  }

  handles(socket: WebSocket): boolean {
    return this.#attachment(socket)?.kind === SOCKET_TAG;
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.handles(socket)) return;
    if (typeof message !== "string") {
      this.#fence(socket, "Hosted Tools requires bounded text frames", 1003);
      return;
    }
    let frame: HostedToolsHostFrame;
    try {
      frame = parseHostedToolsHostFrame(message);
      await this.#dispatchHostFrame(socket, frame);
    } catch (error) {
      const protocol = error instanceof HostedToolsProtocolError
        ? error
        : new HostedToolsProtocolError("broker_failure", errorMessage(error));
      this.#fence(socket, `${protocol.code}: ${protocol.message}`);
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    if (!this.handles(socket)) return;
    this.#retire(socket, reason || `peer closed with code ${code}`);
    closeSocket(socket, code, reason || "Hosted Tools peer closed");
  }

  webSocketError(socket: WebSocket): void {
    if (!this.handles(socket)) return;
    this.#retire(socket, "WebSocket failed");
    closeSocket(socket, 1011, "Hosted Tools WebSocket failed");
  }

  /** May be called by an owning alarm; normal reads and call timers also expire leases lazily. */
  expire(): void {
    const state = this.#persistence.state();
    if (!state.lease_id || state.lease_expires_at > this.#now()) return;
    const socket = this.#socketForState(state);
    if (socket) this.#fence(socket, "Hosted Tools lease expired");
    else this.#retireState(state, "Hosted Tools lease expired");
  }

  cancel(callId: string): boolean {
    const pending = this.#pending.get(callId);
    if (!pending) return false;
    const row = this.#persistence.call(callId);
    if (!row || row.state !== "dispatched") return false;
    const state = this.#persistence.state();
    const socket = this.#socketForState(state);
    if (!socket
      || row.lease_id !== state.lease_id
      || row.generation !== state.generation
      || state.lease_expires_at <= this.#now()) {
      this.#finishAmbiguous(row, "Hosted Tools cancellation lost its pinned attachment");
      return false;
    }
    const cancelRequested = this.#persistence.markCancelRequested(callId, this.#now());
    if (!cancelRequested || cancelRequested.state !== "dispatched"
      || cancelRequested.cancel_requested !== 1) return false;
    try {
      this.#send(socket, {
        type: "cancel",
        call_id: row.call_id,
      });
      return true;
    } catch {
      this.#retire(socket, "cancellation delivery failed");
      closeSocket(socket, 1011, "Hosted Tools cancellation delivery failed");
      return false;
    }
  }

  async #dispatchHostFrame(socket: WebSocket, frame: HostedToolsHostFrame): Promise<void> {
    if (frame.type === "catalog") await this.#publishCatalog(socket, frame);
    else if (frame.type === "ping") this.#heartbeat(socket, frame);
    else if (frame.type === "drain") this.#drain(socket);
    else this.#completeResult(socket, frame);
  }

  #activeAttachment(socket: WebSocket): HostedToolsSocketAttachment {
    const attachment = this.#attachment(socket);
    const state = this.#persistence.state();
    if (!attachment?.active || !attachment.leaseId || attachment.generation === undefined
      || state.lease_id !== attachment.leaseId
      || state.generation !== attachment.generation
      || state.lease_expires_at <= this.#now()) {
      throw new HostedToolsProtocolError("stale_socket", "socket no longer owns the tool attachment");
    }
    return attachment;
  }

  #heartbeat(
    socket: WebSocket,
    frame: Extract<HostedToolsHostFrame, { type: "ping" }>,
  ): void {
    const attachment = this.#activeAttachment(socket);
    const expiresAt = this.#now() + HOSTED_TOOLS_LEASE_MS;
    const state = this.#persistence.state();
    this.#persistence.replaceHost({ ...state, lease_expires_at: expiresAt });
    this.#send(socket, {
      type: "pong",
      nonce: frame.nonce,
    });
  }

  async #publishCatalog(
    socket: WebSocket,
    frame: Extract<HostedToolsHostFrame, { type: "catalog" }>,
  ): Promise<void> {
    const initial = this.#attachment(socket);
    if (!initial || initial.leaseId || initial.generation !== undefined || initial.active) {
      throw new HostedToolsProtocolError("catalog_immutable", "one immutable catalog is allowed per socket");
    }
    if (this.#nextCandidateGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new HostedToolsProtocolError("generation_exhausted", "Hosted Tools generation is exhausted");
    }
    const generation = ++this.#nextCandidateGeneration;
    const leaseId = this.#randomUUID();
    const expiresAt = this.#now() + HOSTED_TOOLS_LEASE_MS;
    const candidate = {
      ...initial,
      leaseId,
      generation,
    } satisfies HostedToolsSocketAttachment;
    socket.serializeAttachment(candidate);
    const catalogJson = JSON.stringify(frame.tools);
    const candidateDefinitions = frame.tools.map((entry) => Object.freeze({
      ...entry,
      definition: Object.freeze({
        ...entry.definition,
        defer_loading: true as const,
      }),
    }));
    try {
      if (initial.allowedMcpIds !== undefined) {
        const allowed = new Set(initial.allowedMcpIds);
        const forbidden = frame.tools.find(({ provider }) => {
          const match = /^mcp:([A-Za-z0-9_-]{43})$/.exec(provider);
          return match === null || !allowed.has(match[1]!);
        });
        if (forbidden) {
          throw new Error(`provider ${forbidden.provider} is not authorized by the MCP grant`);
        }
      }
      const validator = this.#catalogValidator;
      if (validator !== undefined && validator(candidateDefinitions) !== true) {
        throw new Error("ToolRouter rejected the candidate catalog");
      }
    } catch (error) {
      throw new HostedToolsProtocolError(
        "catalog_contract_mismatch",
        `candidate catalog is incompatible with the managed tool route: ${errorMessage(error)}`,
      );
    }
    const now = this.#now();
    const state = this.#persistence.state();
    const replaced = state.lease_id ? state : undefined;
    // A failed ready send must leave the previous attachment routable.
    this.#send(socket, { type: "ready" });
    this.#persistence.transaction(() => {
      if (state.lease_id) {
        this.#persistence.markGenerationAmbiguous(
          state.lease_id,
          state.generation,
          JSON.stringify(ambiguous("Hosted Tools call became ambiguous when its host was replaced")),
          now,
        );
      }
      this.#persistence.replaceHost({
        generation,
        host_id: candidate.sessionId,
        lease_id: leaseId,
        lease_expires_at: expiresAt,
        catalog_json: catalogJson,
      });
    });
    if (replaced?.lease_id) {
      const outcome = ambiguous("Hosted Tools call became ambiguous when its host was replaced");
      this.#resolveGeneration(replaced.lease_id, replaced.generation, outcome);
      for (const existing of this.context.getWebSockets(SOCKET_TAG)) {
        if (existing === socket) continue;
        const old = this.#attachment(existing);
        if (!old?.active || old.leaseId !== replaced.lease_id || old.generation !== replaced.generation) continue;
        closeSocket(existing, 1008, "Hosted Tools attachment replaced");
      }
    }
    socket.serializeAttachment({ ...candidate, active: true } satisfies HostedToolsSocketAttachment);
    this.#notifyCatalogChanged();
  }

  #drain(socket: WebSocket): void {
    const attachment = this.#activeAttachment(socket);
    if (attachment.draining) {
      throw new HostedToolsProtocolError("already_draining", "socket is already draining");
    }
    const state = this.#persistence.state();
    // Visibility is removed before the peer is told that draining began.
    this.#persistence.clearCatalog(state.lease_id!, state.generation);
    socket.serializeAttachment({ ...attachment, draining: true } satisfies HostedToolsSocketAttachment);
    this.#notifyCatalogChanged();
    this.#send(socket, { type: "draining" });
  }

  #completeResult(
    socket: WebSocket,
    frame: Extract<HostedToolsHostFrame, { type: "result" }>,
  ): void {
    const attachment = this.#activeAttachment(socket);
    const row = this.#persistence.call(frame.call_id);
    const stored = JSON.stringify(frame.outcome);
    if (!row
      || row.lease_id !== attachment.leaseId
      || row.generation !== attachment.generation) {
      throw new HostedToolsProtocolError("unknown_call", "result does not match an admitted pinned call");
    }
    if (row.state === "ambiguous") {
      const receiptJson = JSON.stringify({ type: "result", outcome: frame.outcome });
      const recorded = this.#persistence.recordLateReceipt(row.call_id, receiptJson, this.#now());
      if (!recorded || recorded.receipt_json !== receiptJson) {
        throw new HostedToolsProtocolError("result_conflict", "late terminal receipt conflicts with retained proof");
      }
      this.#ackResult(socket, frame);
      return;
    }
    if (row.state !== "dispatched") {
      if (row.result_json === stored && row.state === outcomeState(frame.outcome)) {
        this.#ackResult(socket, frame);
        return;
      }
      throw new HostedToolsProtocolError("result_conflict", "terminal call result cannot be changed");
    }
    if (this.#now() >= row.deadline_at) {
      this.#finishAmbiguous(row, "Hosted Tools call result arrived after its durable deadline");
      const receiptJson = JSON.stringify({ type: "result", outcome: frame.outcome });
      const recorded = this.#persistence.recordLateReceipt(row.call_id, receiptJson, this.#now());
      if (!recorded || recorded.receipt_json !== receiptJson) {
        throw new HostedToolsProtocolError("result_conflict", "late terminal receipt conflicts with retained proof");
      }
      this.#ackResult(socket, frame);
      return;
    }
    if (frame.outcome.status === "completed"
      && encoder.encode(JSON.stringify(frame.outcome.output)).byteLength > row.output_byte_budget) {
      throw new HostedToolsProtocolError(
        "output_budget_exceeded",
        "completed output exceeds the byte budget pinned to the call",
      );
    }
    const completed = this.#persistence.transitionCall(
      row.call_id,
      ["dispatched"],
      outcomeState(frame.outcome),
      stored,
      this.#now(),
    );
    if (!completed || completed.result_json !== stored) {
      throw new HostedToolsProtocolError("result_conflict", "call result lost durable ownership");
    }
    const pending = this.#takePending(row.call_id);
    this.#pruneReceipts();
    this.#ackResult(socket, frame);
    pending?.resolve(frame.outcome);
  }

  #ackResult(socket: WebSocket, frame: Extract<HostedToolsHostFrame, { type: "result" }>): void {
    try {
      this.#send(socket, {
        type: "ack",
        call_id: frame.call_id,
      });
    } catch {
      this.#retire(socket, "result acknowledgement delivery failed");
      closeSocket(socket, 1011, "Hosted Tools result acknowledgement failed");
    }
  }

  #definitions(): readonly HostedToolsProviderDefinition[] {
    const state = this.#persistence.state();
    if (!state.host_id || !state.lease_id || !state.catalog_json) return [];
    if (state.lease_expires_at <= this.#now()) {
      const socket = this.#socketForState(state);
      if (socket) this.#fence(socket, "Hosted Tools lease expired");
      else this.#retireState(state, "Hosted Tools lease expired");
      return [];
    }
    if (!this.#socketForState(state)) return [];
    return JSON.parse(state.catalog_json) as HostedToolCatalogEntry[];
  }

  #resolve(name: string): HostedToolsPreparedTool | undefined {
    const state = this.#persistence.state();
    const definition = this.#definitions().find((candidate) => candidate.definition.name === name);
    if (!definition) return undefined;
    const binding: HostedToolsCatalogBinding = Object.freeze({
      hostId: state.host_id!,
      leaseId: state.lease_id!,
      generation: state.generation,
      entry: definition,
    });
    return Object.freeze({ entry: definition, invoke: (request: HostedToolsInvokeRequest) => this.#invoke(binding, request) });
  }

  #invoke(
    binding: HostedToolsCatalogBinding,
    request: HostedToolsInvokeRequest,
  ): Promise<HostedToolsInvocationOutcome> {
    const retained = this.#persistence.callBySource(request.sessionId, request.callId);
    const leaseId = binding.leaseId;
    const now = this.#now();
    const deadlineAt = request.deadlineAt === undefined && retained
      ? retained.deadline_at
      : Math.min(
        request.deadlineAt ?? Number.MAX_SAFE_INTEGER,
        now + Math.min(binding.entry.timeout_ms, HOSTED_TOOL_CALL_TIMEOUT_MS),
      );
    const outputByteBudget = request.outputByteBudget ?? MAX_HOSTED_TOOL_OUTPUT_BYTES;
    const transportCallId = retained?.call_id ?? this.#randomUUID();
    const hostId = retained?.host_id ?? binding.hostId;
    const pinnedLeaseId = retained?.lease_id ?? binding.leaseId;
    const generation = retained?.generation ?? binding.generation;
    let call: Extract<HostedToolsManagedFrame, { type: "call" }>;
    try {
      call = parseHostedToolsManagedFrame(JSON.stringify({
        type: "call",
        session_id: request.sessionId,
        call_id: transportCallId,
        model: request.model,
        name: binding.entry.definition.name,
        input: request.input,
        output_token_budget: request.outputTokenBudget,
        output_byte_budget: outputByteBudget,
        deadline_at: deadlineAt,
      })) as Extract<HostedToolsManagedFrame, { type: "call" }>;
    } catch (error) {
      return Promise.resolve(unavailable(`Hosted Tools call was invalid before dispatch: ${errorMessage(error)}`));
    }
    const inputJson = JSON.stringify(call.input);
    const proposed: HostedToolsCallRow = {
      call_id: call.call_id,
      session_id: call.session_id,
      source_call_id: request.callId,
      host_id: hostId,
      lease_id: pinnedLeaseId,
      generation,
      model: call.model,
      name: call.name,
      input_json: inputJson,
      output_token_budget: call.output_token_budget,
      output_byte_budget: call.output_byte_budget,
      deadline_at: call.deadline_at,
      cancel_requested: 0,
      state: "admitted",
      result_json: null,
      receipt_json: null,
    };
    if (retained) return this.#repeatedCall(retained, proposed);
    const existing = this.#persistence.call(call.call_id);
    if (existing) return this.#repeatedCall(existing, proposed);
    if (!this.#attachmentIsPresent(binding, now)) {
      return Promise.resolve(preAdmissionUnavailable(
        "Hosted Tools attachment was absent before durable admission",
      ));
    }
    if (this.#persistence.generationCallCount(leaseId, binding.generation)
      >= this.#maxCallsPerGeneration) {
      const state = this.#persistence.state();
      const socket = state.lease_id === leaseId && state.generation === binding.generation
        ? this.#socketForState(state)
        : undefined;
      if (socket) this.#fence(socket, "Hosted Tools generation exhausted its durable call ledger");
      else if (state.lease_id === leaseId && state.generation === binding.generation) {
        this.#retireState(state, "Hosted Tools generation exhausted its durable call ledger");
      }
      return Promise.resolve(unavailable("Hosted Tools generation reached its durable call limit"));
    }
    try {
      this.#persistence.insertCall(proposed, now);
    } catch {
      const recovered = this.#persistence.callBySource(request.sessionId, request.callId)
        ?? this.#persistence.call(call.call_id);
      if (recovered) return this.#repeatedCall(recovered, proposed);
      return Promise.resolve(ambiguous("Hosted Tools admission may have persisted; replay is unsafe"));
    }
    if (request.signal?.aborted) {
      return Promise.resolve(this.#finishBeforeDispatch(proposed, "cancelled", {
        status: "cancelled",
        message: "Hosted Tools call was cancelled before dispatch",
      }));
    }
    const current = this.#persistence.state();
    const dispatchNow = this.#now();
    const socket = this.#routingSocketForState(current);
    if (!socket
      || current.host_id !== binding.hostId
      || current.lease_id !== leaseId
      || current.generation !== binding.generation
      || current.lease_expires_at <= dispatchNow
      || deadlineAt <= dispatchNow) {
      return Promise.resolve(this.#finishBeforeDispatch(
        proposed,
        "unavailable",
        unavailable("Hosted Tools binding became unavailable before dispatch"),
      ));
    }
    if (this.#persistence.activeCallCount(leaseId, binding.generation) > this.#maxInFlight) {
      return Promise.resolve(this.#finishBeforeDispatch(
        proposed,
        "unavailable",
        unavailable("Hosted Tools host is at its bounded in-flight limit"),
      ));
    }
    const dispatched = this.#persistence.transitionCall(
      call.call_id,
      ["admitted"],
      "dispatched",
      "",
      dispatchNow,
    );
    if (!dispatched || dispatched.state !== "dispatched") {
      return Promise.resolve(ambiguous("Hosted Tools call lost durable dispatch ownership"));
    }
    let resolve!: (outcome: HostedToolCallOutcome) => void;
    const promise = new Promise<HostedToolCallOutcome>((completed) => { resolve = completed; });
    const pending: PendingCall = {
      leaseId,
      generation: binding.generation,
      deadlineAt,
      promise,
      resolve,
    };
    this.#pending.set(call.call_id, pending);
    if (request.signal) {
      const cancel = () => { this.cancel(call.call_id); };
      request.signal.addEventListener("abort", cancel, { once: true });
      pending.removeAbort = () => request.signal?.removeEventListener("abort", cancel);
    }
    this.#armExpiry(call.call_id, pending, Math.min(current.lease_expires_at, deadlineAt));
    try {
      this.#send(socket, call);
    } catch {
      this.#retire(socket, "call delivery failed");
      closeSocket(socket, 1011, "Hosted Tools call delivery failed");
    }
    return promise;
  }

  #attachmentIsPresent(
    binding: HostedToolsCatalogBinding,
    now: number,
  ): boolean {
    const current = this.#persistence.state();
    return current.host_id === binding.hostId
      && current.lease_id === binding.leaseId
      && current.generation === binding.generation
      && current.lease_expires_at > now
      && this.#routingSocketForState(current) !== undefined;
  }

  #repeatedCall(existing: HostedToolsCallRow, proposed: HostedToolsCallRow): Promise<HostedToolsInvocationOutcome> {
    if (!sameImmutableCall(existing, proposed)) {
      const state = this.#persistence.state();
      const socket = this.#socketForState(state);
      if (socket) this.#fence(socket, "call ID was reused with different immutable fields");
      return Promise.resolve(ambiguous("Hosted Tools call ID conflicts with retained durable state"));
    }
    if (existing.result_json) return Promise.resolve(JSON.parse(existing.result_json) as HostedToolCallOutcome);
    const pending = this.#pending.get(existing.call_id);
    if (existing.state === "dispatched" && pending) return pending.promise;
    return Promise.resolve(existing.state === "admitted"
      ? unavailable("Hosted Tools call was admitted but never dispatched")
      : ambiguous("Hosted Tools call has no retained terminal receipt"));
  }

  #finishBeforeDispatch(
    row: HostedToolsCallRow,
    state: "unavailable" | "cancelled",
    outcome: HostedToolCallOutcome,
  ): HostedToolCallOutcome {
    this.#persistence.transitionCall(row.call_id, ["admitted"], state, JSON.stringify(outcome), this.#now());
    this.#pruneReceipts();
    return outcome;
  }

  #armExpiry(callId: string, pending: PendingCall, at: number): void {
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      const current = this.#pending.get(callId);
      if (current !== pending) return;
      const state = this.#persistence.state();
      const now = this.#now();
      if (state.lease_id === pending.leaseId
        && state.generation === pending.generation
        && state.lease_expires_at > now
        && pending.deadlineAt > now) {
        this.#armExpiry(callId, pending, Math.min(state.lease_expires_at, pending.deadlineAt));
        return;
      }
      if (state.lease_id === pending.leaseId
        && state.generation === pending.generation
        && state.lease_expires_at <= now) {
        const socket = this.#socketForState(state);
        if (socket) this.#fence(socket, "Hosted Tools lease expired during a call");
        else this.#retireState(state, "Hosted Tools lease expired during a call");
        return;
      }
      const row = this.#persistence.call(callId);
      if (row) {
        this.cancel(callId);
        this.#finishAmbiguous(row, "Hosted Tools call deadline expired after dispatch");
      }
    }, Math.max(1, at - this.#now()));
  }

  #finishAmbiguous(row: HostedToolsCallRow, message: string): void {
    const outcome = ambiguous(message);
    this.#persistence.transitionCall(
      row.call_id,
      ["dispatched"],
      "ambiguous",
      JSON.stringify(outcome),
      this.#now(),
    );
    this.#pruneReceipts();
    this.#takePending(row.call_id)?.resolve(outcome);
  }

  #retire(socket: WebSocket, reason: string): void {
    const attachment = this.#attachment(socket);
    if (!attachment?.leaseId || attachment.generation === undefined) return;
    this.#retireState(this.#persistence.state(), reason, attachment.leaseId, attachment.generation);
  }

  #retireState(
    state: HostedToolsStateRow,
    reason: string,
    leaseId = state.lease_id ?? undefined,
    generation = state.generation,
  ): void {
    if (!leaseId) return;
    const outcome = ambiguous(`Hosted Tools outcome is ambiguous after transport loss: ${reason}`);
    this.#persistence.transaction(() => {
      this.#persistence.markGenerationAmbiguous(leaseId, generation, JSON.stringify(outcome), this.#now());
      this.#persistence.clearHost(leaseId, generation);
    });
    this.#pruneReceipts();
    this.#resolveGeneration(leaseId, generation, outcome);
    this.#notifyCatalogChanged();
  }

  #resolveGeneration(leaseId: string, generation: number, outcome: HostedToolCallOutcome): void {
    for (const [callId, pending] of this.#pending) {
      if (pending.leaseId !== leaseId || pending.generation !== generation) continue;
      this.#takePending(callId)?.resolve(outcome);
    }
  }

  #pruneReceipts(): void {
    const state = this.#persistence.state();
    this.#persistence.pruneReceipts(state.lease_id, state.generation, MAX_RETAINED_RECEIPTS);
  }

  #takePending(callId: string): PendingCall | undefined {
    const pending = this.#pending.get(callId);
    if (!pending) return undefined;
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    pending.removeAbort?.();
    this.#pending.delete(callId);
    return pending;
  }

  #fence(socket: WebSocket, reason: string, code = 1008): void {
    const attachment = this.#attachment(socket);
    if (attachment?.leaseId && attachment.generation !== undefined) {
      this.#retire(socket, reason);
    }
    closeSocket(socket, code, boundedReason(reason));
  }

  #socketForState(state: HostedToolsStateRow): WebSocket | undefined {
    if (!state.host_id || !state.lease_id) return undefined;
    return this.context.getWebSockets(SOCKET_TAG).find((socket) => {
      const attachment = this.#attachment(socket);
      return socket.readyState === WebSocket.OPEN
        && attachment?.leaseId === state.lease_id
        && attachment.generation === state.generation
        && attachment.active === true;
    });
  }

  #routingSocketForState(state: HostedToolsStateRow): WebSocket | undefined {
    if (!state.catalog_json) return undefined;
    const socket = this.#socketForState(state);
    return socket && this.#attachment(socket)?.draining !== true ? socket : undefined;
  }

  #attachment(socket: WebSocket): HostedToolsSocketAttachment | undefined {
    const value = socket.deserializeAttachment() as HostedToolsSocketAttachment | null;
    return value?.kind === SOCKET_TAG ? value : undefined;
  }

  #send(socket: WebSocket, frame: HostedToolsManagedFrame): void {
    socket.send(JSON.stringify(frame));
  }

  #notifyCatalogChanged(): void {
    this.#onCatalogChanged?.(this.#definitions());
  }
}

class SqlHostedToolsPersistence implements HostedToolsBrokerPersistence {
  constructor(readonly storage: DurableObjectStorage) {}

  initialize(now: number): HostedToolsStateRow | undefined {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hosted_tools_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL DEFAULT 0,
        host_id TEXT,
        lease_id TEXT,
        lease_expires_at INTEGER NOT NULL DEFAULT 0,
        catalog_json TEXT
      );
      INSERT OR IGNORE INTO hosted_tools_state (singleton) VALUES (1);
      CREATE TABLE IF NOT EXISTS hosted_tool_calls (
        call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_call_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        model TEXT NOT NULL,
        name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_token_budget INTEGER NOT NULL,
        output_byte_budget INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
        state TEXT NOT NULL CHECK (
          state IN ('admitted', 'dispatched', 'completed', 'unavailable', 'ambiguous', 'cancelled')
        ),
        result_json TEXT,
        receipt_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_tool_calls_source
        ON hosted_tool_calls(session_id, source_call_id);
      CREATE INDEX IF NOT EXISTS hosted_tool_calls_attachment
        ON hosted_tool_calls(lease_id, generation, state);
    `);
    return this.transaction(() => {
      const retired = this.state();
      this.storage.sql.exec(
        `UPDATE hosted_tool_calls SET state = 'unavailable', result_json = ?, updated_at = ?
         WHERE state = 'admitted'`,
        JSON.stringify(unavailable("Hosted Tools lifecycle restarted before dispatch")),
        now,
      );
      this.storage.sql.exec(
        `UPDATE hosted_tool_calls SET state = 'ambiguous', result_json = ?, updated_at = ?
         WHERE state = 'dispatched'`,
        JSON.stringify(ambiguous("Hosted Tools lifecycle restarted after dispatch")),
        now,
      );
      if (retired.lease_id) this.clearHost(retired.lease_id, retired.generation);
      return retired.lease_id ? retired : undefined;
    });
  }

  transaction<T>(callback: () => T): T { return this.storage.transactionSync(callback); }

  state(): HostedToolsStateRow {
    const row = this.storage.sql.exec<HostedToolsStateRow>(
      `SELECT generation, host_id, lease_id, lease_expires_at, catalog_json
       FROM hosted_tools_state WHERE singleton = 1`,
    ).toArray()[0];
    if (!row) throw new Error("Hosted Tools state is missing");
    return row;
  }

  replaceHost(row: HostedToolsStateRow): void {
    this.storage.sql.exec(
      `UPDATE hosted_tools_state
       SET generation = ?, host_id = ?, lease_id = ?, lease_expires_at = ?,
           catalog_json = ?
       WHERE singleton = 1`,
      row.generation,
      row.host_id,
      row.lease_id,
      row.lease_expires_at,
      row.catalog_json,
    );
  }

  clearHost(leaseId: string, generation: number): void {
    this.storage.sql.exec(
      `UPDATE hosted_tools_state
       SET host_id = NULL, lease_id = NULL, lease_expires_at = 0,
           catalog_json = NULL
       WHERE singleton = 1 AND lease_id = ? AND generation = ?`,
      leaseId,
      generation,
    );
  }

  clearCatalog(leaseId: string, generation: number): void {
    this.storage.sql.exec(
      `UPDATE hosted_tools_state
       SET catalog_json = NULL
       WHERE singleton = 1 AND lease_id = ? AND generation = ?`,
      leaseId,
      generation,
    );
  }

  call(callId: string): HostedToolsCallRow | undefined {
    return this.storage.sql.exec<HostedToolsCallRow>(
      `SELECT call_id, session_id, source_call_id, host_id, lease_id, generation,
              model, name, input_json, output_token_budget, output_byte_budget,
              deadline_at, cancel_requested, state, result_json, receipt_json
       FROM hosted_tool_calls WHERE call_id = ?`,
      callId,
    ).toArray()[0];
  }

  callBySource(sessionId: string, sourceCallId: string): HostedToolsCallRow | undefined {
    return this.storage.sql.exec<HostedToolsCallRow>(
      `SELECT call_id, session_id, source_call_id, host_id, lease_id, generation,
              model, name, input_json, output_token_budget, output_byte_budget,
              deadline_at, cancel_requested, state, result_json, receipt_json
       FROM hosted_tool_calls WHERE session_id = ? AND source_call_id = ?`,
      sessionId,
      sourceCallId,
    ).toArray()[0];
  }

  insertCall(row: HostedToolsCallRow, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO hosted_tool_calls
         (call_id, session_id, source_call_id, host_id, lease_id, generation,
          model, name, input_json, output_token_budget, output_byte_budget, deadline_at,
          cancel_requested, state, result_json, receipt_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.call_id,
      row.session_id,
      row.source_call_id,
      row.host_id,
      row.lease_id,
      row.generation,
      row.model,
      row.name,
      row.input_json,
      row.output_token_budget,
      row.output_byte_budget,
      row.deadline_at,
      row.cancel_requested,
      row.state,
      row.result_json,
      row.receipt_json,
      now,
      now,
    );
  }

  markCancelRequested(callId: string, now: number): HostedToolsCallRow | undefined {
    this.storage.sql.exec(
      `UPDATE hosted_tool_calls SET cancel_requested = 1, updated_at = ?
       WHERE call_id = ? AND state = 'dispatched'`,
      now,
      callId,
    );
    return this.call(callId);
  }

  transitionCall(
    callId: string,
    from: readonly HostedToolsCallState[],
    state: HostedToolsCallState,
    resultJson: string,
    now: number,
  ): HostedToolsCallRow | undefined {
    if (from.length === 0) return this.call(callId);
    const placeholders = from.map(() => "?").join(", ");
    this.storage.sql.exec(
      `UPDATE hosted_tool_calls SET state = ?, result_json = ?, updated_at = ?
       WHERE call_id = ? AND state IN (${placeholders})`,
      state,
      resultJson || null,
      now,
      callId,
      ...from,
    );
    return this.call(callId);
  }

  recordLateReceipt(callId: string, receiptJson: string, now: number): HostedToolsCallRow | undefined {
    this.storage.sql.exec(
      `UPDATE hosted_tool_calls SET receipt_json = ?, updated_at = ?
       WHERE call_id = ? AND state = 'ambiguous' AND receipt_json IS NULL`,
      receiptJson,
      now,
      callId,
    );
    return this.call(callId);
  }

  markGenerationAmbiguous(leaseId: string, generation: number, resultJson: string, now: number): void {
    this.storage.sql.exec(
      `UPDATE hosted_tool_calls SET state = 'ambiguous', result_json = ?, updated_at = ?
       WHERE lease_id = ? AND generation = ? AND state = 'dispatched'`,
      resultJson,
      now,
      leaseId,
      generation,
    );
  }

  activeCallCount(leaseId: string, generation: number): number {
    return Number(this.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM hosted_tool_calls
       WHERE lease_id = ? AND generation = ? AND state IN ('admitted', 'dispatched')`,
      leaseId,
      generation,
    ).toArray()[0]?.count ?? 0);
  }

  generationCallCount(leaseId: string, generation: number): number {
    return Number(this.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM hosted_tool_calls
       WHERE lease_id = ? AND generation = ?`,
      leaseId,
      generation,
    ).toArray()[0]?.count ?? 0);
  }

  pruneReceipts(activeLeaseId: string | null, activeGeneration: number, limit: number): void {
    if (activeLeaseId === null) {
      this.storage.sql.exec(
        `DELETE FROM hosted_tool_calls WHERE call_id IN (
           SELECT call_id FROM hosted_tool_calls
           WHERE state NOT IN ('admitted', 'dispatched')
           ORDER BY updated_at DESC, call_id DESC LIMIT -1 OFFSET ?
         )`,
        limit,
      );
      return;
    }
    this.storage.sql.exec(
      `DELETE FROM hosted_tool_calls WHERE call_id IN (
         SELECT call_id FROM hosted_tool_calls
         WHERE state NOT IN ('admitted', 'dispatched')
           AND NOT (lease_id = ? AND generation = ?)
         ORDER BY updated_at DESC, call_id DESC LIMIT -1 OFFSET ?
       )`,
      activeLeaseId,
      activeGeneration,
      limit,
    );
  }
}

function wireToolResult(output: Extract<HostedToolCallOutcome, { status: "completed" }>["output"]): unknown {
  return Object.freeze({
    [TOOL_RESULT]: true,
    metadata: output.metadata,
    output: output.output,
    structuredResult: output.structured_result,
    success: output.success,
    value: output.structured_result ?? output.output,
  });
}

function toolResult(
  output: unknown,
  structuredResult: unknown,
  success: boolean,
  metadata: unknown,
): unknown {
  return Object.freeze({
    [TOOL_RESULT]: true,
    metadata,
    output,
    structuredResult,
    success,
    value: structuredResult ?? output,
  });
}

function sameImmutableCall(left: HostedToolsCallRow, right: HostedToolsCallRow): boolean {
  return left.call_id === right.call_id
    && left.session_id === right.session_id
    && left.source_call_id === right.source_call_id
    && left.host_id === right.host_id
    && left.lease_id === right.lease_id
    && left.generation === right.generation
    && left.model === right.model
    && left.name === right.name
    && left.input_json === right.input_json
    && left.output_token_budget === right.output_token_budget
    && left.output_byte_budget === right.output_byte_budget
    && left.deadline_at === right.deadline_at;
}

function outcomeState(outcome: HostedToolCallOutcome): Exclude<HostedToolsCallState, "admitted" | "dispatched"> {
  return outcome.status;
}

function unavailable(message: string): HostedToolCallOutcome {
  return { status: "unavailable", message: boundedReason(message) };
}

type HostedToolsInvocationOutcome = HostedToolCallOutcome & {
  [HOSTED_TOOLS_PRE_ADMISSION_UNAVAILABLE]?: true;
};

function preAdmissionUnavailable(message: string): HostedToolsInvocationOutcome {
  return Object.freeze({
    ...unavailable(message),
    [HOSTED_TOOLS_PRE_ADMISSION_UNAVAILABLE]: true as const,
  });
}

function ambiguous(message: string): HostedToolCallOutcome {
  return { status: "ambiguous", message: boundedReason(message) };
}

function boundedReason(message: string): string {
  if (encoder.encode(message).byteLength <= 2 * 1024) return message;
  return "Hosted Tools protocol failure exceeded the bounded reason limit";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try { socket.close(code, websocketCloseReason(reason)); }
  catch { /* The socket is already closed or never reached an open state. */ }
}

function websocketCloseReason(reason: string): string {
  if (encoder.encode(reason).byteLength <= 123) return reason;
  let bounded = "";
  for (const scalar of reason) {
    if (encoder.encode(bounded + scalar).byteLength > 123) break;
    bounded += scalar;
  }
  return bounded;
}
