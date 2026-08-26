export type AuthenticatedAccount = Readonly<{
  id: string;
  persistent: boolean;
}>;

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function getCurrentUser(fetcher: typeof fetch = fetch): Promise<AuthenticatedAccount | null> {
  return readCurrentUser(fetcher, true);
}

async function readCurrentUser(
  fetcher: typeof fetch,
  recoverInvalidSession: boolean,
): Promise<AuthenticatedAccount | null> {
  const response = await fetcher("/v1/me", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) {
    const body: unknown = await response.json().catch(() => undefined);
    if (isRecord(body) && body.error === "invalid_session") {
      if (recoverInvalidSession) return readCurrentUser(fetcher, false);
      throw new Error("Couldn’t renew your browser session. Reload and try again.");
    }
    return null;
  }
  if (!response.ok) throw await responseFailure(response, "Account service unavailable.");
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.user)) throw new Error("Invalid account response.");
  const { id, persistent } = body.user;
  if (
    typeof id !== "string"
    || !USER_ID.test(id)
    || typeof persistent !== "boolean"
  ) throw new Error("Invalid account response.");
  return { id, persistent };
}

export async function responseFailure(response: Response, fallback: string): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const reason = isRecord(body) && typeof body.error === "string"
    ? body.error.replaceAll("_", " ")
    : fallback;
  return new Error(reason);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
