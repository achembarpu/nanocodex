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
import { Provider, Storage, webAuthn } from "accounts";
import { clientFailureMessage } from "./clientFailure";
import { deploymentHealth } from "./deploymentHealth";
import { localDevelopmentCredential } from "./localDevelopmentCredential";

export type AuthenticatedAccount = Readonly<{
  id: string;
  persistent: boolean;
}>;

type SessionStatus = "checking" | "ready" | "error";
type AccountOperation = "new-account" | "register" | "sign-in" | "sign-out";

type AccountSession = Readonly<{
  status: SessionStatus;
  account: AuthenticatedAccount | null;
  error: string | null;
  operation: AccountOperation | null;
  refresh: () => Promise<void>;
  startNewAccount: () => Promise<void>;
  register: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}>;

const AccountSessionContext = createContext<AccountSession | null>(null);
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createAccountProvider() {
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
  const refreshRequest = useRef<Promise<void> | undefined>(undefined);
  const localClaim = useRef<Readonly<{
    userId: string;
    promise: Promise<void>;
  }> | undefined>(undefined);

  const claimLocalCredential = useCallback((userId: string) => {
    if (localClaim.current?.userId === userId) return localClaim.current.promise;
    let current!: Promise<void>;
    current = localDevelopmentCredential.ensure(userId).then((claimed) => {
      if (localClaim.current?.promise === current && claimed) {
        notifyModelCredentialChanged();
      }
    }, () => {
      if (localClaim.current?.promise === current) {
        localClaim.current = undefined;
      }
    });
    localClaim.current = { userId, promise: current };
    return current;
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (refreshRequest.current) return refreshRequest.current;
    const currentRequest = ++requestId.current;
    let current!: Promise<void>;
    current = getCurrentUser().then(
      async (nextUser) => {
        if (requestId.current !== currentRequest) return;
        if (nextUser) {
          await claimLocalCredential(nextUser.id);
          if (requestId.current !== currentRequest) return;
        }
        setUser(nextUser);
        setStatus("ready");
        setError(null);
        if (!nextUser) localClaim.current = undefined;
      },
      (cause: unknown) => {
        if (requestId.current !== currentRequest) return;
        setStatus("error");
        setError(accountFailure(cause, "Couldn’t check your account session."));
      },
    ).finally(() => {
      if (refreshRequest.current === current) refreshRequest.current = undefined;
    });
    refreshRequest.current = current;
    return current;
  }, [claimLocalCredential]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async (method: "login" | "register") => {
    const nextOperation = method === "register" ? "register" : "sign-in";
    setOperation(nextOperation);
    setError(null);
    try {
      if (method === "register" && !user) throw new Error("The browser identity is not ready.");
      await accountProvider().request(method === "register"
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
      await claimLocalCredential(nextUser.id);
      requestId.current++;
      setUser(nextUser);
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
  }, [accountProvider, claimLocalCredential, user]);

  const register = useCallback(() => connect("register"), [connect]);
  const signIn = useCallback(() => connect("login"), [connect]);
  const startNewAccount = useCallback(async () => {
    setOperation("new-account");
    setError(null);
    try {
      const nextUser = await getCurrentUser();
      if (!nextUser) throw new Error("The browser session was not created.");
      await claimLocalCredential(nextUser.id);
      requestId.current++;
      setUser(nextUser);
      setStatus("ready");
    } catch (cause) {
      setError(accountFailure(cause, "Couldn’t start a new account. Try again."));
    } finally {
      setOperation(null);
    }
  }, [claimLocalCredential]);
  const signOut = useCallback(async () => {
    setOperation("sign-out");
    setError(null);
    try {
      await accountProvider().request({ method: "wallet_disconnect" });
      const nextUser = await getCurrentUser();
      if (nextUser) await claimLocalCredential(nextUser.id);
      requestId.current++;
      setUser(nextUser);
      setStatus("ready");
      if (!nextUser) localClaim.current = undefined;
    } catch (cause) {
      setError(accountFailure(cause, "Couldn’t sign out. Try again."));
    } finally {
      setOperation(null);
    }
  }, [accountProvider, claimLocalCredential]);

  const value = useMemo<AccountSession>(() => ({
    account: user,
    status,
    error,
    operation,
    refresh,
    startNewAccount,
    register,
    signIn,
    signOut,
  }), [error, operation, refresh, register, signIn, signOut, startNewAccount, status, user]);

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
    const body: unknown = await response.json().catch(() => undefined);
    if (isRecord(body) && body.error === "invalid_session") {
      throw new Error("Your account session expired. Retry to start a new browser session, or sign in with your passkey.");
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
  return clientFailureMessage(cause, fallback);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
