import {
  Agent as NanocodexAgent,
  createTempoProviderFromAccounts,
  Transport as NanocodexTransport,
} from "../../host/index.mjs";
import { mercatorRestTool } from "../mercator.mjs";
import { connectorRequestTools } from "../connectors.mjs";

const PROVIDER_NAME = "ChatGPT · Nanocodex Connect";
const tempoMcp = Symbol.for("nanocodex.tempo.mcp");

/** Creates one real Nanocodex agent from an active Connect grant. */
export async function create(client, options) {
  const connection = options?.connection;
  if (!connection || typeof connection !== "object") {
    throw new TypeError("agent.create requires an active connection");
  }
  if (connection.grant?.status !== "active") {
    throw new Error("The Connect grant is not active.");
  }
  if (!connection.grant.connectors?.includes("chatgpt")) {
    throw new Error("Connect ChatGPT before creating a Nanocodex agent.");
  }

  const toolCalls = createToolCallLedger();
  const configuredSession = options?.session ?? {};
  const channelStore = configuredSession.channelStore
    ?? await connectChannelStore(connection);
  const boostProvider = await createTempoProviderFromAccounts({
    wallet: client.provider,
    account: connection.accountAddress,
    accessKey: connection.accessKey.keyId,
    chainId: Number(connection.accessKey.chainId),
    policy: {
      // BOOST payments are cumulative across a Mercator workflow. Let its
      // channel grow only as far as the signed daily grant while keeping each
      // incremental top-up small.
      autoSwap: true,
      maxDeposit: decimalAtomics(connection.mpp.limit, 6),
      topUpAmount: "0.01",
      ...options?.payment,
    },
    session: {
      bootstrap: true,
      ...(typeof globalThis.WebSocket === "function"
        ? { webSocket: boundedCloseWebSocket(globalThis.WebSocket) }
        : {}),
      ...(channelStore ? { channelStore } : {}),
      ...configuredSession,
    },
    mercator: options?.mercator,
    payment: { maxAmount: connection.mpp.maxPerRequest },
  });
  const tools = connectTools(
    client,
    connection,
    options?.tools,
    toolCalls,
    boostProvider.fetch,
    new URL("/v1/mercator/jobs", client.transport.baseUrl).href,
  );

  let raw;
  try {
    raw = await NanocodexAgent.create({
      transport: NanocodexTransport.hostManaged({
        websocketUrl: grantModelWebSocketUrl(client, connection).href,
        createWebSocket: (_endpoint, sessionId, request) => createGrantModelWebSocket(
          client,
          connection,
          sessionId,
          request,
        ),
      }),
      fastMode: options?.fastMode ?? true,
      thinking: options?.thinking ?? "none",
      instructions: options?.instructions
        ?? "You are the Nanocodex Connect agent. Use connectGrant before making claims about the active authorization. When connector_request is available, use it for authenticated GitHub, Gmail, or Google Drive API requests; it never exposes connector credentials and never supports ChatGPT. Mercator create_job may return a run_rest_request handoff; execute that exact handoff with run_rest_request, then poll it with Mercator get_job. Answer directly and never invent capabilities that are absent from tool results.",
      model: options?.model,
      reasoningMode: options?.reasoningMode,
      ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      tools,
      mcp: options?.mcp === false
        ? false
        : { ...boostProvider[tempoMcp], ...options?.mcp },
      toolMode: options?.toolMode,
    });
  } catch (error) {
    // No channel is opened during construction, so do not call the manager's
    // on-chain close path when initialization itself fails.
    throw error;
  }

  let shutdown;
  const agent = {
    id: raw.sessionId,
    type: "connect",
    provider: PROVIDER_NAME,
    mercator: Object.freeze({
      enabled: true,
      get channelId() {
        return boostProvider.session.channelId;
      },
      get cumulative() {
        return boostProvider.session.cumulative;
      },
      get opened() {
        return boostProvider.session.opened;
      },
    }),
    turn: Object.freeze({
      prompt(parameters) {
        const input = parameters?.input;
        if (typeof input !== "string" || input.trim().length === 0) {
          throw new TypeError("agent prompt requires input");
        }
        const callRecord = toolCalls.open();
        const turn = raw.turn.prompt({ input });
        const accepted = turn.accepted();
        const completion = Promise.all([accepted, turn.result()]);
        void completion.then(
          () => toolCalls.close(callRecord),
          () => toolCalls.close(callRecord),
        );
        const signal = parameters.signal;
        const cancel = () => { void turn.cancel(); };
        signal?.addEventListener("abort", cancel, { once: true });
        return Object.freeze({
          accepted,
          async result() {
            let completed;
            try {
              const [turnId, value] = await completion;
              completed = value;
              const usage = await completed.usage();
              return Object.freeze({
                turnId,
                finalMessage: completed.finalMessage,
                provider: PROVIDER_NAME,
                capabilitiesUsed: Object.freeze([
                  "nanocodex.agent",
                  "chatgpt",
                  ...[...callRecord.calls].map((name) => `tool.${name}`),
                ]),
                usage,
              });
            } finally {
              signal?.removeEventListener("abort", cancel);
              completed?.dispose();
              turn.dispose();
            }
          },
          cancel: () => turn.cancel(),
        });
      },
    }),
    session: Object.freeze({
      shutdown() {
        return shutdown ??= (async () => {
          const errors = [];
          try {
            await raw.session.shutdown();
          } catch (error) {
            errors.push(error);
          }
          try {
            await boostProvider.close?.();
          } catch (error) {
            errors.push(error);
          }
          raw.dispose();
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) {
            throw new AggregateError(errors, "Nanocodex agent shutdown and BOOST settlement both failed");
          }
        })();
      },
    }),
  };
  return Object.freeze(agent);
}

/** @internal Opens one Responses WebSocket through the grant's connected ChatGPT account. */
export async function createGrantModelWebSocket(
  client,
  connection,
  sessionId,
  request = {},
  WebSocketImpl = globalThis.WebSocket,
) {
  if (typeof WebSocketImpl !== "function") {
    throw new Error("WebSocket is unavailable in this runtime");
  }
  const issued = await client.request({
    method: "POST",
    path: `/v1/grants/${connection.grant.id}/model/ticket`,
    body: {
      session_id: sessionId,
      ...(typeof request.turnState === "string" && request.turnState
        ? { turn_state: request.turnState }
        : {}),
    },
  });
  if (!issued || typeof issued.ticket !== "string" || !issued.ticket) {
    throw new Error("Nanocodex Connect returned no model ticket");
  }
  const endpoint = grantModelWebSocketUrl(client, connection);
  endpoint.searchParams.set("session_id", sessionId);
  endpoint.searchParams.set("ticket", issued.ticket);
  return new WebSocketImpl(endpoint);
}

function grantModelWebSocketUrl(client, connection) {
  const endpoint = new URL(`/v1/grants/${connection.grant.id}/model`, client.transport.baseUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return endpoint;
}

/** @internal */
export function decimalAtomics(value, decimals) {
  const atomics = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = atomics / scale;
  const fraction = (atomics % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

// Browsers reject WebSocket close reasons above 123 UTF-8 bytes. MPP keeps
// the complete failure on its receipt promise; this only bounds the protocol
// close frame so a useful payment error is not replaced by a DOMException.
function boundedCloseWebSocket(WebSocketImpl) {
  return class NanocodexWebSocket extends WebSocketImpl {
    close(code, reason) {
      super.close(code, closeReason(reason));
    }
  };
}

function closeReason(reason) {
  if (typeof reason !== "string") return reason;
  let bounded = "";
  let bytes = 0;
  for (const character of reason) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 123) break;
    bounded += character;
    bytes += size;
  }
  return bounded;
}

const channelStores = new Map();

async function connectChannelStore(connection) {
  if (typeof localStorage === "undefined") return undefined;
  const account = connection.accountAddress.toLowerCase();
  const accessKey = connection.accessKey.keyId.toLowerCase();
  const key = `${account}:${accessKey}`;
  if (channelStores.has(key)) return channelStores.get(key);

  try {
    const { Session } = await import("mppx/tempo");
    const legacyPrefix = `nanocodex:connect:mpp:${account}:`;
    const prefix = `${legacyPrefix}${accessKey}:`;
    // Relocate prototype snapshots by the authority encoded in the signed
    // channel descriptor. This repairs both the original account-only key and
    // any prior incorrectly guessed namespace without adopting another key's
    // channel.
    for (const name of Object.keys(localStorage)) {
      if (!name.startsWith(legacyPrefix) || !name.includes(":chan:")) continue;
      const value = localStorage.getItem(name);
      if (value === null) continue;
      let snapshot;
      try {
        snapshot = JSON.parse(value);
      } catch {
        continue;
      }
      if (snapshot?.descriptor?.authorizedSigner?.toLowerCase() !== accessKey) continue;
      const channelName = name.slice(name.indexOf("chan:", legacyPrefix.length));
      const migrated = prefix + channelName;
      if (localStorage.getItem(migrated) === null) {
        localStorage.setItem(migrated, value);
      }
      if (name !== migrated) localStorage.removeItem(name);
    }
    const store = Session.Client.createJsonChannelStore({
      get(name) {
        return localStorage.getItem(prefix + name) ?? undefined;
      },
      set(name, value) {
        localStorage.setItem(prefix + name, value);
      },
      delete(name) {
        localStorage.removeItem(prefix + name);
      },
    });
    channelStores.set(key, store);
    return store;
  } catch {
    // Storage can be disabled by an embedding browser. The session remains
    // usable for the current page and shutdown still closes it cooperatively.
    return undefined;
  }
}

function connectTools(client, connection, configured, calls, paymentFetch, mercatorRelay) {
  const tools = normalizeTools(configured);
  for (const name of ["connectGrant", "connector_request", "run_rest_request"]) {
    if (Object.hasOwn(tools, name)) {
      throw new TypeError(`${name} is reserved by Nanocodex Connect`);
    }
  }
  return {
    ...tools,
    ...connectorRequestTools(client, connection, calls),
    run_rest_request: mercatorRestTool({
      connection,
      fetch: paymentFetch,
      calls,
      relay: mercatorRelay,
    }),
    connectGrant: {
      description: "Read the exact active Nanocodex Connect grant, delegated access key, and bounded MPP policy. Call this before describing the grant.",
      parameters: { type: "object", additionalProperties: false },
      async handler(_input, context) {
        calls.add("connectGrant", context);
        return {
          account: connection.accountAddress,
          grant: {
            id: connection.grant.id,
            permission: connection.grant.permission,
            status: connection.grant.status,
            expiresAt: connection.grant.expiresAt,
            capabilities: connection.grant.capabilities,
            connectors: connection.grant.connectors,
          },
          accessKey: {
            id: connection.accessKey.keyId,
            type: connection.accessKey.keyType,
            expiry: connection.accessKey.expiry,
            witness: connection.accessKey.witness,
            limits: connection.accessKey.limits.map((limit) => ({
              token: limit.token,
              limit: limit.limit.toString(),
              period: limit.period,
            })),
            scopes: connection.accessKey.scopes,
          },
          mpp: {
            token: connection.mpp.token,
            symbol: connection.mpp.symbol,
            balance: connection.mpp.balance.toString(),
            settlementToken: connection.mpp.settlementToken,
            settlementSymbol: connection.mpp.settlementSymbol,
            settlementBalance: connection.mpp.settlementBalance.toString(),
            dailyLimit: connection.mpp.limit.toString(),
            maxPerRequest: connection.mpp.maxPerRequest.toString(),
          },
        };
      },
    },
  };
}

function createToolCallLedger() {
  const pending = [];
  const bySignal = new WeakMap();
  return {
    open() {
      const record = { bound: false, calls: new Set(), closed: false };
      pending.push(record);
      return record;
    },
    close(record) {
      record.closed = true;
      const index = pending.indexOf(record);
      if (index !== -1) pending.splice(index, 1);
    },
    add(name, context) {
      const signal = context?.signal;
      let record = signal && typeof signal === "object" ? bySignal.get(signal) : undefined;
      if (!record) {
        record = pending.find((candidate) => !candidate.closed && !candidate.bound);
        if (!record) return;
        record.bound = true;
        if (signal && typeof signal === "object") bySignal.set(signal, record);
      }
      record.calls.add(name);
    },
  };
}

function normalizeTools(tools) {
  if (tools === undefined) return {};
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
    throw new TypeError("Connect agent tools must be an object map");
  }
  const wrapped = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool.handler !== "function") {
      throw new TypeError(`Connect agent tool ${name} requires a handler`);
    }
    wrapped[name] = {
      ...tool,
      async handler(input, context) {
        return tool.handler(input, context);
      },
    };
  }
  return wrapped;
}
