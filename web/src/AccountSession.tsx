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
import {
  getCurrentUser,
  isRecord,
  responseFailure,
  type AuthenticatedAccount,
} from "./accountSessionRequest";
import { clientFailureMessage } from "./clientFailure";

export { isRecord, responseFailure } from "./accountSessionRequest";
export type { AuthenticatedAccount } from "./accountSessionRequest";

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

  const refresh = useCallback((): Promise<void> => {
    if (refreshRequest.current) return refreshRequest.current;
    const currentRequest = ++requestId.current;
    let current!: Promise<void>;
    current = getCurrentUser().then(
      (nextUser) => {
        if (requestId.current !== currentRequest) return;
        setUser(nextUser);
        setStatus("ready");
        setError(null);
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
  }, [accountProvider, user]);

  const register = useCallback(() => connect("register"), [connect]);
  const signIn = useCallback(() => connect("login"), [connect]);
  const startNewAccount = useCallback(async () => {
    setOperation("new-account");
    setError(null);
    try {
      const nextUser = await getCurrentUser();
      if (!nextUser) throw new Error("The browser session was not created.");
      requestId.current++;
      setUser(nextUser);
      setStatus("ready");
    } catch (cause) {
      setError(accountFailure(cause, "Couldn’t start a new account. Try again."));
    } finally {
      setOperation(null);
    }
  }, []);
  const signOut = useCallback(async () => {
    setOperation("sign-out");
    setError(null);
    try {
      await accountProvider().request({ method: "wallet_disconnect" });
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

function accountFailure(cause: unknown, fallback: string): string {
  if (cause instanceof DOMException && cause.name === "NotAllowedError") {
    return "No matching passkey was available, or the request was cancelled. Try another passkey or create a new account.";
  }
  return clientFailureMessage(cause, fallback);
}
