import { Agent as ManagedAgent } from "../../managed/index.mjs";
import { registerManagedAgentAlias } from "../../managed/internal.mjs";

const PROVIDER_NAME = "ChatGPT · Nanocodex Connect";

/** Opens the durable Nanocodex agent provisioned by a signed Connect approval. */
export async function create(client, options) {
  const connection = options?.connection;
  if (!connection || typeof connection !== "object") {
    throw new TypeError("agent.create requires an active connection");
  }
  if (connection.grant?.status !== "active") {
    throw new Error("The Connect authorization is not active.");
  }
  if (!connection.grant.connectors?.includes("chatgpt")) {
    throw new Error("Connect ChatGPT before opening the durable Nanocodex agent.");
  }
  const unsupported = Object.keys(options ?? {}).find((key) => key !== "connection");
  if (unsupported) {
    throw new TypeError(`Connect durable agents do not accept app-local ${unsupported}`);
  }

  const grantSession = client._captureSession?.();
  if (!grantSession) throw new Error("The Connect authorization session is unavailable.");
  const managedOptions = {
    baseUrl: client.transport.baseUrl,
    fetch: managedGrantFetch(
      grantSession,
      client.transport.baseUrl,
      connection.grant.id,
      connection.agentId,
    ),
  };
  const managed = ManagedAgent.open(connection.agentId, managedOptions);
  return connectAgent(managed, connection, {
    baseUrl: client.transport.baseUrl,
    grantSession,
  });
}

function connectAgent(managed, connection, transport) {
  const visibility = connection.grant.visibility;
  const agent = {
    id: managed.id,
    sessionId: managed.id,
    type: "connect",
    provider: PROVIDER_NAME,
    state: () => managed.state(),
    events: Object.freeze({
      async page(options) {
        const page = await managed.events.page(options);
        if (!visibility.conversationHistory && !visibility.rawTraces) {
          return Object.freeze({
            data: Object.freeze([]),
            hasMore: false,
            latestCursor: page.latestCursor,
          });
        }
        return Object.freeze({
          ...page,
          data: Object.freeze(page.data
            .map((event) => projectManagedEvent(event, visibility))
            .filter(Boolean)),
        });
      },
      watch(options) {
        return projectManagedEvents(managed.events.watch(options), visibility);
      },
    }),
    mercator: Object.freeze({
      enabled: true,
      channelId: undefined,
      cumulative: 0n,
      opened: false,
    }),
    turn: Object.freeze({
      prompt(parameters) {
        const turn = managed.turn.prompt(parameters);
        return Object.freeze({
          idempotencyKey: turn.idempotencyKey,
          accepted: () => turn.accepted(),
          state: () => turn.state(),
          steer: (options) => turn.steer(options),
          cancel: () => turn.cancel(),
          async result(options) {
            const result = await turn.result(options);
            return Object.freeze({
              ...result,
              finalMessage: visibility.finalMessages ? result.finalMessage : "",
              provider: PROVIDER_NAME,
              capabilitiesUsed: Object.freeze([]),
            });
          },
        });
      },
    }),
    session: Object.freeze({
      async shutdown() {},
    }),
  };
  registerManagedAgentAlias(agent, managed, {
    voiceTransport: connectVoiceTransport(transport, connection.grant.id, connection.agentId),
  });
  return Object.freeze(agent);
}

function connectVoiceTransport({ baseUrl, grantSession }, grantId, agentId) {
  const grantPath = `/v1/grants/${grantId}/agents/${encodeURIComponent(agentId)}/realtime`;
  return Object.freeze({
    call(body, signal) {
      const callBody = managedRealtimeCallBody(body, agentId);
      return grantSession.fetch(new Request(new URL(`${grantPath}/calls`, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: callBody,
        signal,
      }));
    },
    async sidebandUrl(callId) {
      const response = await grantSession.fetch(new Request(new URL(`${grantPath}/ticket`, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ call_id: callId }),
      }));
      const receipt = await response.json().catch(() => undefined);
      if (!response.ok || typeof receipt?.ticket !== "string") {
        throw new Error(receipt?.error?.message ?? "voice sideband authorization failed");
      }
      const url = new URL(`${grantPath}/sideband`, baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("call_id", callId);
      url.searchParams.set("ticket", receipt.ticket);
      return url;
    },
  });
}

function managedRealtimeCallBody(encoded, agentId) {
  let envelope;
  try { envelope = JSON.parse(encoded); }
  catch { throw new TypeError("Connect voice call body is invalid"); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || envelope.managed_agent_id !== agentId
    || typeof envelope.call_body !== "string") {
    throw new TypeError("Connect voice call body is invalid");
  }
  return envelope.call_body;
}

function managedGrantFetch(session, baseUrl, grantId, agentId) {
  const origin = new URL(baseUrl).origin;
  const prefix = `/v1/agents/${encodeURIComponent(agentId)}`;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) {
      throw new TypeError("Connect managed fetch is restricted to its authorized durable agent");
    }
    url.pathname = `/v1/grants/${grantId}/agents/${encodeURIComponent(agentId)}${url.pathname.slice(prefix.length)}`;
    if (input instanceof Request) {
      const request = init === undefined ? input : new Request(input, init);
      return session.fetch(new Request(url, request));
    }
    return session.fetch(url, init);
  };
}

async function* projectManagedEvents(events, visibility) {
  try {
    for await (const event of events) {
      const projected = projectManagedEvent(event, visibility);
      if (projected) yield projected;
    }
  } finally {
    await events.return?.();
  }
}

function projectManagedEvent(event, visibility) {
  if (visibility.rawTraces) return event;
  const data = event?.data;
  if (!data || typeof data !== "object") return undefined;
  if (data.type === "event") {
    const eventType = data.event?.type;
    if ((eventType === "assistant.delta" || eventType === "assistant.message")
      && visibility.finalMessages) {
      const payload = data.event?.payload;
      return payload?.phase === "commentary" ? undefined : event;
    }
    return visibility.actionSummaries
      && (eventType === "tool.call" || eventType === "tool.result")
      ? event
      : undefined;
  }
  if (data.type === "turn_completed" && !visibility.finalMessages) {
    return Object.freeze({
      ...event,
      data: Object.freeze({ ...data, final_message: "" }),
    });
  }
  return event;
}

/** @internal Projects app-visible result fields from the signed SIWE resources. */
export function projectAgentObservations(visibility, finalMessage, capabilitiesUsed) {
  return Object.freeze({
    finalMessage: visibility.finalMessages ? finalMessage : "",
    capabilitiesUsed: Object.freeze(visibility.actionSummaries ? [...capabilitiesUsed] : []),
  });
}
