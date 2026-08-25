import {
  authenticate,
  requireSameOriginMutation,
  type AccountAuthEnv,
} from "./account-auth";
import { fetchResponseWithDeadline } from "./deadline";

type CredentialEnv = AccountAuthEnv & { NANOCODEX: Fetcher };

const DEFAULT_OWNERSHIP_IO_TIMEOUT_MS = 10_000;
const CREDENTIAL_BIND_ATTEMPTS = 3;
const CREDENTIAL_BIND_RETRY_MS = 25;

const ROUTES = new Map<string, ReadonlySet<string>>([
  ["/v1/credentials", new Set(["GET"])],
  ["/v1/credentials/openai", new Set(["PUT", "DELETE"])],
  ["/v1/credentials/chatgpt", new Set(["DELETE"])],
  ["/v1/credentials/chatgpt/login", new Set(["GET", "POST"])],
  ["/v1/credentials/local-claim", new Set(["POST"])],
]);

export async function routeCredentialRequest(
  request: Request,
  env: CredentialEnv,
  url: URL,
): Promise<Response | undefined> {
  const methods = ROUTES.get(url.pathname);
  if (!methods) return undefined;
  if (!methods.has(request.method)) return json({ error: "method_not_allowed" }, 405);
  if (url.search) return json({ error: "invalid_request" }, 400);

  const principal = await authenticate(request, env, url);
  if (!principal || principal.kind !== "account_session") {
    return json({ error: "unauthorized" }, 401);
  }
  if (request.method !== "GET") {
    const originFailure = requireSameOriginMutation(request, url, principal);
    if (originFailure) return originFailure;
  }

  const suffix = url.pathname.slice("/v1/credentials".length);
  const polling = suffix === "/chatgpt/login" && request.method === "GET";
  const brokerSuffix = suffix === "/local-claim"
    ? "/chatgpt/local-claim"
    : polling ? "/chatgpt/login/status" : suffix;
  const target = `https://broker.internal/users/${encodeURIComponent(principal.userId)}/credentials${brokerSuffix}`;
  return env.NANOCODEX.fetch(target, {
    method: polling ? "POST" : request.method,
    ...(request.body === null ? {} : {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: request.body,
    }),
  });
}

export async function bindAgentCredential(
  binding: Fetcher,
  subject: string,
  userId: string,
  timeoutMs = DEFAULT_OWNERSHIP_IO_TIMEOUT_MS,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < CREDENTIAL_BIND_ATTEMPTS; attempt += 1) {
    try {
      await fetchResponseWithDeadline(
        binding,
        `https://broker.internal/subjects/${subject}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user_id: userId }),
        },
        timeoutMs,
        "credential subject binding",
        (response) => {
          if (!response.ok) {
            const error = new Error(
              `credential subject binding failed with HTTP ${response.status}`,
            );
            throw Object.assign(error, {
              code: response.status === 408 || response.status === 429 || response.status >= 500
                ? "retryable"
                : "definitive",
            });
          }
        },
        { retryable: true },
      );
      return;
    } catch (error) {
      failure = error;
      if (errorCode(error) === "definitive" || attempt === CREDENTIAL_BIND_ATTEMPTS - 1) {
        throw error;
      }
      const baseDelay = CREDENTIAL_BIND_RETRY_MS * (2 ** attempt);
      await scheduler.wait(baseDelay + Math.floor(Math.random() * baseDelay));
    }
  }
  throw failure;
}

export async function unbindAgentCredential(
  binding: Fetcher,
  subject: string,
  userId: string,
  timeoutMs = DEFAULT_OWNERSHIP_IO_TIMEOUT_MS,
): Promise<void> {
  await fetchResponseWithDeadline(
    binding,
    `https://broker.internal/subjects/${subject}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    },
    timeoutMs,
    "credential subject unbinding",
    (response) => {
      if (!response.ok && response.status !== 404) {
        throw new Error(`credential subject unbinding failed with HTTP ${response.status}`);
      }
    },
    { retryable: true },
  );
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}
