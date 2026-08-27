export type BrowserAccountSession = Readonly<{ id: string; persistent: boolean }>;

export class BrowserAccountReauthenticationRequiredError extends Error {
  constructor() {
    super("Your passkey session expired. Sign in to restore your account.");
    this.name = "BrowserAccountReauthenticationRequiredError";
  }
}

export function readBrowserAccountSession(
  fetcher: typeof fetch = fetch,
): Promise<BrowserAccountSession | null> {
  return readSession(fetcher, true);
}

export async function logoutBrowserAccountSession(
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/webauthn/logout", {
    credentials: "same-origin",
    method: "POST",
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error("The Nanocodex account service could not end this browser session.");
  }
}

async function readSession(
  fetcher: typeof fetch,
  recoverInvalidSession: boolean,
): Promise<BrowserAccountSession | null> {
  const response = await fetcher("/v1/me", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status === 401) {
    if (isRecord(body) && body.error === "reauthentication_required") {
      throw new BrowserAccountReauthenticationRequiredError();
    }
    if (isRecord(body) && body.error === "invalid_session" && recoverInvalidSession) {
      return readSession(fetcher, false);
    }
    return null;
  }
  if (!response.ok) throw new Error("The Nanocodex account service is unavailable.");
  if (!isRecord(body) || !isRecord(body.user)
    || typeof body.user.id !== "string"
    || typeof body.user.persistent !== "boolean") {
    throw new Error("The Nanocodex account service returned an invalid browser session.");
  }
  return { id: body.user.id, persistent: body.user.persistent };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
