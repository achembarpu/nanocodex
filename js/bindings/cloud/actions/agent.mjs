import { Agent as ManagedAgent } from "../../managed/index.mjs";

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
  return connectAgent(managed, connection);
}

function connectAgent(managed, connection) {
  const visibility = connection.grant.visibility;
  return Object.freeze({
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
  });
}

function managedGrantFetch(session, baseUrl, grantId, agentId) {
  const origin = new URL(baseUrl).origin;
  const prefix = `/v1/agents/${encodeURIComponent(agentId)}`;
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) {
      throw new TypeError("Connect managed fetch is restricted to its authorized durable agent");
    }
    url.pathname = `/v1/grants/${grantId}/agents/${encodeURIComponent(agentId)}${url.pathname.slice(prefix.length)}`;
    return session.fetch(new Request(url, request));
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
