import { Provider, Storage, webAuthn } from "accounts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type AuthenticatedAccount = Readonly<{
  id: string;
  address: `0x${string}`;
  chainId: number;
}>;

type SessionStatus = "checking" | "ready" | "error";
type AccountOperation = "register" | "sign-in" | "sign-out";

type AccountSession = Readonly<{
  status: SessionStatus;
  account: AuthenticatedAccount | null;
  error: string | null;
  operation: AccountOperation | null;
  refresh: () => Promise<void>;
  register: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}>;

const AccountSessionContext = createContext<AccountSession | null>(null);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function createAccountProvider() {
  return Provider.create({
    adapter: webAuthn({
      auth: "/webauthn",
      name: "Nanocodex",
      rdns: "xyz.paradigm.nanocodex",
    }),
    auth: "/auth",
    maxAccounts: 1,
    mpp: false,
    storage: Storage.idb({ key: "nanocodex" }),
  });
}

export function AccountSessionProvider({ children }: { children: ReactNode }) {
  const providerRef = useRef<ReturnType<typeof createAccountProvider> | null>(null);
  if (!providerRef.current) providerRef.current = createAccountProvider();

  const [status, setStatus] = useState<SessionStatus>("checking");
  const [user, setUser] = useState<AuthenticatedAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<AccountOperation | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const nextUser = await getCurrentUser();
      if (requestId.current !== currentRequest) return;
      setUser(nextUser);
      if (nextUser) await claimLocalCredential();
      setStatus("ready");
      setError(null);
    } catch (cause) {
      if (requestId.current !== currentRequest) return;
      setStatus("error");
      setError(accountFailure(cause, "Couldn’t check your account session."));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async (method: "login" | "register") => {
    const nextOperation = method === "register" ? "register" : "sign-in";
    setOperation(nextOperation);
    setError(null);
    try {
      await providerRef.current!.request(method === "register"
        ? {
            method: "wallet_connect",
            params: [{ capabilities: { method, name: "Nanocodex" } }],
          }
        : { method: "wallet_connect" });
      const nextUser = await getCurrentUser();
      if (!nextUser) throw new Error("The account session was not created.");
      requestId.current++;
      setUser(nextUser);
      await claimLocalCredential();
      setStatus("ready");
    } catch (cause) {
      setError(accountFailure(
        cause,
        method === "register"
          ? "Couldn’t register this passkey. Try again."
          : "Couldn’t sign in with a passkey. Try again.",
      ));
    } finally {
      setOperation(null);
    }
  }, []);

  const register = useCallback(() => connect("register"), [connect]);
  const signIn = useCallback(() => connect("login"), [connect]);
  const signOut = useCallback(async () => {
    setOperation("sign-out");
    setError(null);
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw await responseFailure(response, "Couldn’t sign out.");
      await response.body?.cancel();
      await providerRef.current!.request({ method: "wallet_disconnect" });
      const nextUser = await getCurrentUser();
      if (nextUser) throw new Error("The account session is still active.");
      requestId.current++;
      setUser(null);
      setStatus("ready");
    } catch (cause) {
      setError(accountFailure(cause, "Couldn’t sign out. Try again."));
    } finally {
      setOperation(null);
    }
  }, []);

  const value = useMemo<AccountSession>(() => ({
    account: user,
    status,
    error,
    operation,
    refresh,
    register,
    signIn,
    signOut,
  }), [error, operation, refresh, register, signIn, signOut, status, user]);

  return (
    <AccountSessionContext.Provider value={value}>
      {children}
    </AccountSessionContext.Provider>
  );
}

export function useAccountSession(): AccountSession {
  const session = useContext(AccountSessionContext);
  if (!session) throw new Error("useAccountSession must be used within AccountSessionProvider");
  return session;
}

async function getCurrentUser(): Promise<AuthenticatedAccount | null> {
  const response = await fetch("/v1/me", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw await responseFailure(response, "Account service unavailable.");
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.user)) throw new Error("Invalid account response.");
  const { id, address, chain_id: chainId } = body.user;
  if (
    typeof id !== "string"
    || typeof address !== "string"
    || !ADDRESS.test(address)
    || typeof chainId !== "number"
    || !Number.isSafeInteger(chainId)
  ) throw new Error("Invalid account response.");
  return { id, address: address as `0x${string}`, chainId };
}

async function claimLocalCredential(): Promise<void> {
  if (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") return;
  await fetch("/v1/credentials/local-claim", {
    method: "POST",
    credentials: "same-origin",
  }).then(async (response) => {
    await response.body?.cancel();
    if (response.ok) notifyModelCredentialChanged();
  }).catch(() => {});
}

function notifyModelCredentialChanged(): void {
  window.dispatchEvent(new Event("nanocodex:model-credential-changed"));
}

export async function responseFailure(response: Response, fallback: string): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const reason = isRecord(body) && typeof body.error === "string"
    ? body.error.replaceAll("_", " ")
    : fallback;
  return new Error(reason);
}

function accountFailure(cause: unknown, fallback: string): string {
  if (cause instanceof DOMException && cause.name === "NotAllowedError") {
    return "The passkey request was cancelled or timed out. Try again.";
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
