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
import { deploymentHealth } from "./deploymentHealth";
import { localDevelopmentCredential } from "./localDevelopmentCredential";

export type AuthenticatedAccount = Readonly<{
  id: string;
  persistent: boolean;
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
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function createAccountProvider() {
  const { Provider, Storage, webAuthn } = await import("accounts");
  return Provider.create({
    adapter: webAuthn({
      auth: "/webauthn",
      name: "Nanocodex",
      rdns: "xyz.paradigm.nanocodex",
    }),
    maxAccounts: 1,
    mpp: false,
    storage: Storage.idb({ key: "nanocodex" }),
  });
}

export function AccountSessionProvider({ children }: { children: ReactNode }) {
  const providerRef = useRef<ReturnType<typeof createAccountProvider> | null>(null);
  const accountProvider = useCallback(() => {
    providerRef.current ??= createAccountProvider();
    return providerRef.current;
  }, []);

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
      setStatus("ready");
      setError(null);
      if (nextUser) void claimLocalCredential(nextUser.id);
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
      if (method === "register" && !user) throw new Error("The browser identity is not ready.");
      await (await accountProvider()).request(method === "register"
        ? {
            method: "wallet_connect",
            params: [{ capabilities: {
              method,
              name: `Nanocodex ${user!.id}`,
              userId: user!.id,
            } }],
          }
        : { method: "wallet_connect" });
      const nextUser = await getCurrentUser();
      if (!nextUser) throw new Error("The account session was not created.");
      requestId.current++;
      setUser(nextUser);
      setStatus("ready");
      void claimLocalCredential(nextUser.id);
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
  }, [accountProvider, user]);

  const register = useCallback(() => connect("register"), [connect]);
  const signIn = useCallback(() => connect("login"), [connect]);
  const signOut = useCallback(async () => {
    setOperation("sign-out");
    setError(null);
    try {
      await (await accountProvider()).request({ method: "wallet_disconnect" });
      const nextUser = await getCurrentUser();
      requestId.current++;
      setUser(nextUser);
      setStatus("ready");
    } catch (cause) {
      setError(accountFailure(cause, "Couldn’t sign out. Try again."));
    } finally {
      setOperation(null);
    }
  }, [accountProvider]);

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
  const { id, persistent } = body.user;
  if (
    typeof id !== "string"
    || !USER_ID.test(id)
    || typeof persistent !== "boolean"
  ) throw new Error("Invalid account response.");
  return { id, persistent };
}

async function claimLocalCredential(userId: string): Promise<void> {
  await localDevelopmentCredential.ensure(userId).then((claimed) => {
    if (claimed) notifyModelCredentialChanged();
  }).catch(() => {});
}

function notifyModelCredentialChanged(): void {
  deploymentHealth.invalidate();
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
