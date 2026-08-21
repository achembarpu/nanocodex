type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type PublicSecurityEnv = {
  ENVIRONMENT: string;
  AUTH_START_LIMIT?: RateLimitBinding;
  AUTH_GLOBAL_LIMIT?: RateLimitBinding;
  SESSION_POLL_LIMIT?: RateLimitBinding;
  AGENT_SOCKET_LIMIT?: RateLimitBinding;
  AGENT_TOOL_LIMIT?: RateLimitBinding;
  AGENT_IMAGE_LIMIT?: RateLimitBinding;
  GUEST_SOCKET_LIMIT?: RateLimitBinding;
  GUEST_TURN_GLOBAL_LIMIT?: RateLimitBinding;
  GUEST_TURN_LIMIT?: RateLimitBinding;
  GUEST_TOOL_LIMIT?: RateLimitBinding;
  GUEST_IMAGE_LIMIT?: RateLimitBinding;
  GUEST_QUOTA?: DurableObjectNamespace;
};

export type MeteredOperation = "socket" | "search" | "image";
export type GuestMeteredOperation = MeteredOperation | "turn";

export const GUEST_QUOTA = {
  periodSeconds: 60,
  sessionStarts: 2,
  modelResponses: 6,
  toolRequests: 8,
  imageRequests: 1,
  daily: {
    modelResponses: 12,
    toolRequests: 20,
    imageRequests: 1,
  },
  deploymentDaily: {
    modelResponses: 200,
    toolRequests: 400,
    imageRequests: 20,
  },
} as const;

export async function limitLoginStart(
  request: Request,
  env: PublicSecurityEnv,
): Promise<Response | undefined> {
  const fingerprint = await digestKey([
    request.headers.get("cf-connecting-ip") ?? "unknown-ip",
    request.headers.get("user-agent") ?? "unknown-agent",
  ].join("\n"));
  return await enforce(env, env.AUTH_GLOBAL_LIMIT, "login:global")
    ?? await enforce(env, env.AUTH_START_LIMIT, `login:${fingerprint}`);
}

export async function limitSessionPoll(
  env: PublicSecurityEnv,
  sessionId: string,
): Promise<Response | undefined> {
  return enforce(env, env.SESSION_POLL_LIMIT, `poll:${sessionId}`);
}

export async function limitAgentOperation(
  env: PublicSecurityEnv,
  actorId: string,
  operation: MeteredOperation,
): Promise<Response | undefined> {
  const actor = await digestKey(actorId);
  const binding = operation === "socket"
    ? env.AGENT_SOCKET_LIMIT
    : operation === "image"
      ? env.AGENT_IMAGE_LIMIT
      : env.AGENT_TOOL_LIMIT;
  return enforce(env, binding, `${operation}:${actor}`);
}

/** Applies both deployment-wide sponsor capacity and one pseudonymous client's quota. */
export async function limitGuestOperation(
  request: Request,
  env: PublicSecurityEnv,
  operation: GuestMeteredOperation,
): Promise<Response | undefined> {
  const globalBinding = operation === "turn"
    ? env.GUEST_TURN_GLOBAL_LIMIT
    : operation === "socket"
      ? env.AGENT_SOCKET_LIMIT
      : operation === "image"
        ? env.AGENT_IMAGE_LIMIT
        : env.AGENT_TOOL_LIMIT;
  const clientBinding = operation === "turn"
    ? env.GUEST_TURN_LIMIT
    : operation === "socket"
      ? env.GUEST_SOCKET_LIMIT
      : operation === "image"
        ? env.GUEST_IMAGE_LIMIT
        : env.GUEST_TOOL_LIMIT;
  const clientAddress = request.headers.get("cf-connecting-ip")
    ?? (env.ENVIRONMENT === "development" ? "development-loopback" : undefined);
  if (!clientAddress) return guestLimitResponse(unavailable());
  const fingerprint = await digestKey(clientAddress);
  const limited = await enforce(env, globalBinding, `guest:${operation}:global`)
    ?? await enforce(env, clientBinding, `guest:${operation}:${fingerprint}`);
  if (limited) return guestLimitResponse(limited);
  if (operation === "socket") return undefined;
  return admitGuestQuota(env, fingerprint, operation);
}

/** Production guest access fails closed unless every sponsored operation is bounded. */
export function guestProtectionConfigured(env: PublicSecurityEnv): boolean {
  return Boolean(
    env.AGENT_SOCKET_LIMIT
    && env.AGENT_TOOL_LIMIT
    && env.AGENT_IMAGE_LIMIT
    && env.GUEST_SOCKET_LIMIT
    && env.GUEST_TURN_GLOBAL_LIMIT
    && env.GUEST_TURN_LIMIT
    && env.GUEST_TOOL_LIMIT
    && env.GUEST_IMAGE_LIMIT
    && env.GUEST_QUOTA,
  );
}

async function admitGuestQuota(
  env: PublicSecurityEnv,
  actor: string,
  operation: Exclude<GuestMeteredOperation, "socket">,
): Promise<Response | undefined> {
  if (!env.GUEST_QUOTA) return guestLimitResponse(unavailable());
  try {
    const stub = env.GUEST_QUOTA.get(env.GUEST_QUOTA.idFromName("deployment"));
    const response = await stub.fetch("https://guest-quota.internal/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor, operation }),
    });
    if (response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch {
    return guestLimitResponse(unavailable());
  }
}

export async function apiKeyActorId(apiKey: string): Promise<string> {
  return `api-key:${await digestKey(apiKey)}`;
}

async function enforce(
  env: PublicSecurityEnv,
  binding: RateLimitBinding | undefined,
  key: string,
): Promise<Response | undefined> {
  if (!binding) {
    if (env.ENVIRONMENT === "production" || env.ENVIRONMENT === "preview") {
      return unavailable();
    }
    return undefined;
  }
  try {
    const { success } = await binding.limit({ key });
    return success ? undefined : rateLimited();
  } catch {
    return unavailable();
  }
}

function rateLimited(): Response {
  return Response.json(
    { error: "rate_limit_exceeded" },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": "60",
      },
    },
  );
}

function unavailable(): Response {
  return Response.json(
    { error: "abuse_protection_unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

function guestLimitResponse(response: Response): Response {
  const exhausted = response.status === 429;
  return Response.json(
    {
      error: exhausted
        ? "Guest quota is exhausted. Retry in a minute or sign in with ChatGPT."
        : "Guest access is temporarily unavailable. Sign in with ChatGPT or try again later.",
      code: exhausted ? "guest_quota_exhausted" : "guest_access_unavailable",
      ...(exhausted ? { reset_after_seconds: 60 } : {}),
    },
    {
      status: response.status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(exhausted ? { "retry-after": response.headers.get("retry-after") ?? "60" } : {}),
      },
    },
  );
}

type DailyOperation = "turn" | "search" | "image";
type DailyUsage = {
  day: string;
  global: Record<DailyOperation, number>;
  actors: Record<string, Record<DailyOperation, number>>;
};

/** Serialized hard budget for the deployment-sponsored credential. */
export class GuestQuota {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/admit") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    let body: { actor?: unknown; operation?: unknown };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const actor = typeof body.actor === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.actor)
      ? body.actor
      : undefined;
    const operation = body.operation === "turn" || body.operation === "search" || body.operation === "image"
      ? body.operation
      : undefined;
    if (!actor || !operation) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const resetAt = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    const admitted = await this.#state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<DailyUsage>("usage");
      const usage = stored?.day === day ? stored : emptyDailyUsage(day);
      const globalLimit = dailyLimit(operation, true);
      const actorLimit = dailyLimit(operation, false);
      const actorUsage = usage.actors[actor] ?? { turn: 0, search: 0, image: 0 };
      if (usage.global[operation] >= globalLimit || actorUsage[operation] >= actorLimit) {
        return false;
      }
      usage.global[operation] += 1;
      actorUsage[operation] += 1;
      usage.actors[actor] = actorUsage;
      await transaction.put("usage", usage);
      return true;
    });
    if (admitted) return new Response(null, { status: 204 });
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000));
    return Response.json(
      {
        error: "Guest daily quota is exhausted. Sign in with ChatGPT or try again tomorrow.",
        code: "guest_quota_exhausted",
        operation,
        reset_at: new Date(resetAt).toISOString(),
      },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(retryAfter),
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}

function emptyDailyUsage(day: string): DailyUsage {
  return {
    day,
    global: { turn: 0, search: 0, image: 0 },
    actors: {},
  };
}

function dailyLimit(operation: DailyOperation, deployment: boolean): number {
  const quota = deployment ? GUEST_QUOTA.deploymentDaily : GUEST_QUOTA.daily;
  return operation === "turn"
    ? quota.modelResponses
    : operation === "search"
      ? quota.toolRequests
      : quota.imageRequests;
}

async function digestKey(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
