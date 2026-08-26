import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Provider, Storage, webAuthn } from "accounts";
import type {
  AccountSelection,
  StoredPasskey,
} from "@nanocodex-connect/AccountChooser";
import {
  getCurrentUser,
  isRecord,
  ReauthenticationRequiredError,
  responseFailure,
  type AuthenticatedAccount,
} from "./accountSessionRequest";
import { logoutBrowserAccountSession } from "@nanocodex-connect/browserAccountSession";
import { clientFailureMessage } from "./clientFailure";

export { isRecord, responseFailure } from "./accountSessionRequest";
export type { AuthenticatedAccount } from "./accountSessionRequest";

type SessionStatus = "checking" | "ready" | "error";
type AccountOperation = "register" | "sign-in" | "sign-out";

type AccountSession = Readonly<{
  status: SessionStatus;
  account: AuthenticatedAccount | null;
  error: string | null;
  operation: AccountOperation | null;
  savedPasskeys: readonly StoredPasskey[];
  chooseAccount: (selection: AccountSelection) => Promise<void>;
  refresh: () => Promise<void>;
  register: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  reauthenticationRequired: boolean;
}>;

const AccountSessionContext = createContext<AccountSession | null>(null);

function createAccountProvider() {
  return Provider.create({
    adapter: webAuthn({
      auth: "/webauthn",
      name: "Nanocodex",
      rdns: "xyz.paradigm.nanocodex",
    }),
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
  const provider = accountProvider();
  const providerStore = (provider as unknown as {
    store: {
      getState(): { accounts: readonly Readonly<{
        address: `0x${string}`;
        credential?: Readonly<{ id: string }> | undefined;
        label?: string | undefined;
      }>[] };
      subscribe(listener: () => void): () => void;
    };
  }).store;
  const providerAccounts = useSyncExternalStore(
    providerStore.subscribe,
    () => providerStore.getState().accounts,
    () => providerStore.getState().accounts,
  );
  const savedPasskeys = useMemo(() => providerAccounts.flatMap((account) => account.credential?.id
    ? [{
        address: account.address,
        credentialId: account.credential.id,
        label: account.label,
      } satisfies StoredPasskey]
    : []), [providerAccounts]);

  const [status, setStatus] = useState<SessionStatus>("checking");
  const [user, setUser] = useState<AuthenticatedAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<AccountOperation | null>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
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
        setReauthenticationRequired(false);
      },
      (cause: unknown) => {
        if (requestId.current !== currentRequest) return;
        if (cause instanceof ReauthenticationRequiredError) {
          setUser(null);
          setStatus("ready");
          setError(null);
          setReauthenticationRequired(true);
          return;
        }
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

  const chooseAccount = useCallback(async (selection: AccountSelection) => {
    const nextOperation = selection.mode === "register" ? "register" : "sign-in";
    setOperation(nextOperation);
    setError(null);
    try {
      let registrationUser = user;
      if (selection.mode === "register" && (!registrationUser || registrationUser.persistent)) {
        await logoutBrowserAccountSession();
        registrationUser = await getCurrentUser();
      }
      if (selection.mode === "register" && !registrationUser) {
        throw new Error("The browser identity is not ready.");
      }
      await provider.request({
        method: "wallet_connect",
        params: [{ capabilities: selection.mode === "register"
          ? {
              method: "register",
              name: selection.label,
              userId: registrationUser!.id,
            }
          : {
              method: "login",
              ...(selection.credentialId
                ? { credentialId: selection.credentialId }
                : { selectAccount: true }),
            } }],
      });
      const nextUser = await getCurrentUser();
      if (!nextUser) throw new Error("The account session was not created.");
      requestId.current++;
      setUser(nextUser);
      setStatus("ready");
      setReauthenticationRequired(false);
    } catch (cause) {
      setError(accountFailure(
        cause,
        selection.mode === "register"
          ? "Couldn’t register this passkey. Try again."
          : "Couldn’t sign in with a passkey. Try again.",
      ));
    } finally {
      setOperation(null);
    }
  }, [provider, user]);

  const register = useCallback(() => chooseAccount({
    mode: "register",
    label: user ? `Nanocodex ${user.id}` : "Nanocodex account",
  }), [chooseAccount, user]);
  const signIn = useCallback(() => chooseAccount({
    mode: "login",
    label: "Another passkey",
    discoverCredential: true,
  }), [chooseAccount]);
  const signOut = useCallback(async () => {
    setOperation("sign-out");
    setError(null);
    try {
      await logoutBrowserAccountSession();
      const nextUser = await getCurrentUser();
      requestId.current++;
      setUser(nextUser);
      setStatus("ready");
      setReauthenticationRequired(false);
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
    savedPasskeys,
    chooseAccount,
    refresh,
    register,
    signIn,
    signOut,
    reauthenticationRequired,
  }), [chooseAccount, error, operation, reauthenticationRequired, refresh, register, savedPasskeys, signIn, signOut, status, user]);

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
