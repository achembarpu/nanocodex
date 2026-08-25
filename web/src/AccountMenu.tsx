import { Check, CircleUserRound, Copy, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { isRecord, responseFailure, useAccountSession } from "./AccountSession";
import { clientFailureMessage } from "./clientFailure";
import { deploymentHealth } from "./deploymentHealth";
import { ProfileConnectors } from "./ProfileConnectors";

type ApiKeyMetadata = Readonly<{
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
}>;

type NewApiKey = Readonly<{
  token: string;
  metadata: ApiKeyMetadata;
}>;

type CredentialStatus = Readonly<{
  ready: boolean;
  active: "openai" | "chatgpt" | null;
  openai: { connected: boolean };
  chatgpt: {
    connected: boolean;
    accountId?: string;
    login?: {
      verificationUrl: string;
      userCode: string;
      expiresAt: number;
      pollAfterMs: number;
    };
  };
}>;

type AccountDataRequest = Readonly<{
  accountId: string;
  promise: Promise<void>;
}>;

const API_KEY_ID = /^[A-Za-z0-9_-]{12}$/;

export function AccountMenu() {
  const session = useAccountSession();
  const refreshSession = session.refresh;
  const accountId = session.account?.id;
  const [open, setOpen] = useState(() => new URL(window.location.href).searchParams.has("connector_result"));
  const [keys, setKeys] = useState<ApiKeyMetadata[] | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyOperation, setKeyOperation] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<NewApiKey | null>(null);
  const [label, setLabel] = useState("");
  const [copied, setCopied] = useState(false);
  const [credentials, setCredentials] = useState<CredentialStatus | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [providerOperation, setProviderOperation] = useState<string | null>(null);
  const [openAiKey, setOpenAiKey] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const cachedAccountId = useRef<string | undefined>(undefined);
  const keyRequest = useRef<AccountDataRequest | undefined>(undefined);
  const credentialRequest = useRef<AccountDataRequest | undefined>(undefined);

  const close = useCallback(() => {
    setOpen(false);
    setNewKey(null);
    setCopied(false);
  }, []);

  const loadKeys = useCallback((): Promise<void> => {
    if (!accountId) return Promise.resolve();
    if (keyRequest.current?.accountId === accountId) return keyRequest.current.promise;
    if (cachedAccountId.current === accountId) setKeyError(null);
    let current!: Promise<void>;
    current = (async () => {
      try {
        const response = await apiRequest("/v1/api-keys");
        if (response.status === 401) {
          await response.body?.cancel();
          await refreshSession();
          return;
        }
        if (!response.ok) throw await responseFailure(response, "Couldn’t load API keys.");
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("Invalid API key response.");
        if (cachedAccountId.current === accountId) setKeys(body.data.map(decodeApiKey));
      } catch (cause) {
        if (cachedAccountId.current === accountId) {
          setKeyError(failureMessage(cause, "Couldn’t load API keys."));
        }
      }
    })().finally(() => {
      if (keyRequest.current?.promise === current) keyRequest.current = undefined;
    });
    keyRequest.current = { accountId, promise: current };
    return current;
  }, [accountId, refreshSession]);

  const loadCredentials = useCallback((): Promise<void> => {
    if (!accountId) return Promise.resolve();
    if (credentialRequest.current?.accountId === accountId) {
      return credentialRequest.current.promise;
    }
    if (cachedAccountId.current === accountId) setCredentialError(null);
    let current!: Promise<void>;
    current = (async () => {
      try {
        const response = await apiRequest("/v1/credentials");
        if (response.status === 401) {
          await response.body?.cancel();
          await refreshSession();
          return;
        }
        if (!response.ok) throw await responseFailure(response, "Couldn’t load model connections.");
        const nextCredentials = decodeCredentialStatus(await response.json());
        if (cachedAccountId.current === accountId) setCredentials(nextCredentials);
      } catch (cause) {
        if (cachedAccountId.current === accountId) {
          setCredentialError(failureMessage(cause, "Couldn’t load model connections."));
        }
      }
    })().finally(() => {
      if (credentialRequest.current?.promise === current) credentialRequest.current = undefined;
    });
    credentialRequest.current = { accountId, promise: current };
    return current;
  }, [accountId, refreshSession]);

  const pollChatGpt = useCallback(async () => {
    try {
      const response = await apiRequest("/v1/credentials/chatgpt/login");
      if (!response.ok) throw await responseFailure(response, "Couldn’t check ChatGPT sign-in.");
      const value: unknown = await response.json();
      if (isRecord(value) && value.state === "pending") {
        const login = decodeChatGptLogin(value);
        setCredentials((current) => current ? {
          ...current,
          chatgpt: { ...current.chatgpt, login },
        } : current);
        return;
      }
      await loadCredentials();
      notifyModelCredentialChanged();
    } catch (cause) {
      setCredentialError(failureMessage(cause, "Couldn’t check ChatGPT sign-in."));
    }
  }, [loadCredentials]);

  useEffect(() => {
    if (!accountId) {
      cachedAccountId.current = undefined;
      setKeys(null);
      setKeyError(null);
      setNewKey(null);
      setCredentials(null);
      setCredentialError(null);
      return;
    }
    const accountChanged = cachedAccountId.current !== accountId;
    if (accountChanged) {
      cachedAccountId.current = accountId;
      setKeys(null);
      setKeyError(null);
      setNewKey(null);
      setCredentials(null);
      setCredentialError(null);
    }
    if (!open) return;
    const missing: Promise<void>[] = [];
    if (accountChanged || keys === null) missing.push(loadKeys());
    if (accountChanged || credentials === null) missing.push(loadCredentials());
    void Promise.all(missing);
  }, [accountId, credentials, keys, loadCredentials, loadKeys, open]);

  useEffect(() => {
    const login = credentials?.chatgpt.login;
    if (!open || !login) return;
    const timer = window.setTimeout(
      () => void pollChatGpt(),
      Math.max(1_000, login.pollAfterMs),
    );
    return () => window.clearTimeout(timer);
  }, [credentials?.chatgpt.login, open, pollChatGpt]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  const createKey = async (event: FormEvent) => {
    event.preventDefault();
    if (keyOperation) return;
    setKeyOperation("create");
    setKeyError(null);
    setNewKey(null);
    try {
      const response = await apiRequest("/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (response.status === 401) {
        await response.body?.cancel();
        await refreshSession();
        return;
      }
      if (!response.ok) throw await responseFailure(response, "Couldn’t create the API key.");
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.api_key !== "string") {
        throw new Error("Invalid API key response.");
      }
      const metadata = decodeApiKey(body.key);
      setKeys((current) => [metadata, ...(current ?? []).filter((key) => key.id !== metadata.id)]);
      setNewKey({ token: body.api_key, metadata });
      setLabel("");
    } catch (cause) {
      setKeyError(failureMessage(cause, "Couldn’t create the API key."));
    } finally {
      setKeyOperation(null);
    }
  };

  const revokeKey = async (key: ApiKeyMetadata) => {
    if (keyOperation) return;
    setKeyOperation(key.id);
    setKeyError(null);
    try {
      const response = await apiRequest(`/v1/api-keys/${encodeURIComponent(key.id)}`, {
        method: "DELETE",
      });
      if (response.status === 401) {
        await response.body?.cancel();
        await refreshSession();
        return;
      }
      if (!response.ok) throw await responseFailure(response, "Couldn’t revoke the API key.");
      await response.body?.cancel();
      setKeys((current) => current?.filter((candidate) => candidate.id !== key.id) ?? []);
      if (newKey?.metadata.id === key.id) setNewKey(null);
    } catch (cause) {
      setKeyError(failureMessage(cause, "Couldn’t revoke the API key."));
    } finally {
      setKeyOperation(null);
    }
  };

  const copyNewKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey.token);
      setCopied(true);
    } catch {
      setKeyError("Couldn’t copy the API key. Select and copy it manually.");
    }
  };

  const connectOpenAi = async (event: FormEvent) => {
    event.preventDefault();
    if (!openAiKey.trim() || providerOperation) return;
    setProviderOperation("openai");
    setCredentialError(null);
    try {
      const response = await apiRequest("/v1/credentials/openai", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: openAiKey.trim() }),
      });
      if (!response.ok) throw await responseFailure(response, "Couldn’t connect the OpenAI key.");
      setOpenAiKey("");
      await loadCredentials();
      notifyModelCredentialChanged();
    } catch (cause) {
      setCredentialError(failureMessage(cause, "Couldn’t connect the OpenAI key."));
    } finally {
      setProviderOperation(null);
    }
  };

  const startChatGpt = async () => {
    if (providerOperation) return;
    const popup = window.open("about:blank", "nanocodex-chatgpt-login");
    if (popup) popup.opener = null;
    setProviderOperation("chatgpt");
    setCredentialError(null);
    try {
      const response = await apiRequest("/v1/credentials/chatgpt/login", { method: "POST" });
      if (!response.ok) throw await responseFailure(response, "Couldn’t start ChatGPT sign-in.");
      const login = decodeChatGptLogin(await response.json());
      setCredentials((current) => current ? {
        ...current,
        chatgpt: { ...current.chatgpt, login },
      } : null);
      if (popup) popup.location.href = login.verificationUrl;
      else window.open(login.verificationUrl, "_blank", "noopener,noreferrer");
    } catch (cause) {
      popup?.close();
      setCredentialError(failureMessage(cause, "Couldn’t start ChatGPT sign-in."));
    } finally {
      setProviderOperation(null);
    }
  };

  const disconnectProvider = async (provider: "openai" | "chatgpt") => {
    if (providerOperation) return;
    setProviderOperation(provider);
    setCredentialError(null);
    try {
      const response = await apiRequest(`/v1/credentials/${provider}`, { method: "DELETE" });
      if (!response.ok) throw await responseFailure(response, `Couldn’t disconnect ${provider}.`);
      await response.body?.cancel();
      await loadCredentials();
      notifyModelCredentialChanged();
    } catch (cause) {
      setCredentialError(failureMessage(cause, `Couldn’t disconnect ${provider}.`));
    } finally {
      setProviderOperation(null);
    }
  };

  const accountLabel = session.account?.persistent ? shortIdentity(session.account.id) : "account";

  return (
    <div className="account-menu" ref={menuRef}>
      <button
        className="account-menu-trigger"
        type="button"
        aria-label={accountLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => open ? close() : setOpen(true)}
      >
        <CircleUserRound aria-hidden="true" />
        <span>{accountLabel}</span>
      </button>
      {open && session.status !== "checking" ? (
        <section className="account-panel" aria-label="Nanocodex profile">
          <header className="account-panel-header">
            <div>
              <span>Profile</span>
              {session.account ? <strong>{session.account.persistent
                ? shortIdentity(session.account.id)
                : "This browser"}</strong> : null}
            </div>
            <button type="button" aria-label="Close account panel" onClick={close}>
              <X aria-hidden="true" />
            </button>
          </header>

          {session.error ? (
            <div className="account-failure" role="alert">
              <p>{session.error}</p>
              <button type="button" onClick={() => void session.refresh()}>Retry</button>
            </div>
          ) : null}

          {session.account ? (
            <>
              <div className="account-summary">
                <span>{session.account.persistent ? "Passkey identity" : "Browser session"}</span>
                <span>{session.account.persistent ? "Available across devices" : "Add a passkey to keep it"}</span>
                {session.account.persistent ? (
                  <button
                    type="button"
                    disabled={session.operation !== null}
                    onClick={() => void session.signOut()}
                  >
                    Sign out
                  </button>
                ) : null}
              </div>

              {!session.account.persistent ? (
                <div className="account-auth-actions">
                  <p>Connect ChatGPT now, or add a passkey to keep this identity across devices.</p>
                  <button
                    className="account-primary-action"
                    type="button"
                    disabled={session.operation !== null}
                    onClick={() => void session.register()}
                  >
                    Add passkey
                  </button>
                  <button
                    type="button"
                    disabled={session.operation !== null}
                    onClick={() => void session.signIn()}
                  >
                    Use existing passkey
                  </button>
                </div>
              ) : null}

              <section className="api-key-panel account-profile-content" aria-labelledby="connections-heading">
                <div className="api-key-heading">
                  <div>
                    <h2 id="connections-heading">Connections</h2>
                    <p>Services your agents can use through the private broker.</p>
                  </div>
                </div>

                {credentialError ? (
                  <div className="account-failure" role="alert">
                    <p>{credentialError}</p>
                    <button type="button" onClick={() => void loadCredentials()}>Retry</button>
                  </div>
                ) : null}

                <ProfileConnectors
                  accountId={session.account.id}
                  key={session.account.id}
                  requiresLogin={!session.account.persistent}
                  refreshSession={refreshSession}
                >
                  {credentials ? (
                    <>
                      <div className="account-provider-row">
                        <div>
                          <strong>ChatGPT</strong>
                          <span>{credentials.chatgpt.connected
                            ? `Connected${credentials.active === "chatgpt" ? " · active" : ""}`
                            : "Not connected"}</span>
                        </div>
                        {credentials.chatgpt.connected ? (
                          <button type="button" onClick={() => void disconnectProvider("chatgpt")}>Disconnect</button>
                        ) : (
                          <button type="button" onClick={() => void startChatGpt()}>Connect ChatGPT</button>
                        )}
                      </div>
                      {credentials.chatgpt.login ? (
                        <div className="new-api-key" role="status">
                          <strong>Finish ChatGPT sign-in</strong>
                          <p>Enter this code on the OpenAI page, then leave this panel open.</p>
                          <code>{credentials.chatgpt.login.userCode}</code>
                          <a href={credentials.chatgpt.login.verificationUrl} target="_blank" rel="noreferrer">Open sign-in page</a>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </ProfileConnectors>

                <div className="account-api-keys" aria-labelledby="api-key-heading">
                  <div className="api-key-heading">
                    <div>
                      <h2 id="api-key-heading">API keys</h2>
                      <p>Bring an OpenAI key or create one for the Nanocodex managed API.</p>
                    </div>
                  </div>

                  {credentials ? (
                    <>
                      <div className="account-provider-row">
                        <div>
                          <strong>OpenAI</strong>
                          <span>{credentials.openai.connected
                            ? `Connected${credentials.active === "openai" ? " · active" : ""}`
                            : "Not connected"}</span>
                        </div>
                        {credentials.openai.connected ? (
                          <button type="button" onClick={() => void disconnectProvider("openai")}>Disconnect</button>
                        ) : null}
                      </div>
                      {!credentials.openai.connected ? (
                        <form className="api-key-create" onSubmit={(event) => void connectOpenAi(event)}>
                          <label htmlFor="openai-key">OpenAI API key</label>
                          <div>
                            <input
                              id="openai-key"
                              type="password"
                              autoComplete="off"
                              value={openAiKey}
                              placeholder="sk-…"
                              onChange={(event) => setOpenAiKey(event.target.value)}
                            />
                            <button type="submit" disabled={!openAiKey.trim() || providerOperation !== null}>Connect</button>
                          </div>
                        </form>
                      ) : null}
                    </>
                  ) : null}

                  {keyError ? (
                    <div className="account-failure" role="alert">
                      <p>{keyError}</p>
                      <button type="button" onClick={() => void loadKeys()}>Retry</button>
                    </div>
                  ) : null}

                  {keys && newKey ? (
                    <div className="new-api-key" role="status">
                      <strong>Copy this key now</strong>
                      <p>It won’t be shown again.</p>
                      <code>{newKey.token}</code>
                      <div>
                        <button type="button" onClick={() => void copyNewKey()}>
                          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                          {copied ? "Copied" : "Copy key"}
                        </button>
                        <button type="button" onClick={() => setNewKey(null)}>Dismiss</button>
                      </div>
                    </div>
                  ) : null}

                  {keys ? (
                    <form className="api-key-create" onSubmit={(event) => void createKey(event)}>
                      <label htmlFor="api-key-label">Nanocodex API key</label>
                      <div>
                        <input
                          id="api-key-label"
                          value={label}
                          maxLength={120}
                          placeholder="CLI, CI, or laptop"
                          onChange={(event) => setLabel(event.target.value)}
                        />
                        <button type="submit" disabled={keyOperation !== null}>Create</button>
                      </div>
                    </form>
                  ) : null}

                  {keys?.length ? (
                    <ul className="api-key-list">
                      {keys.map((key) => (
                        <li key={key.id}>
                          <div>
                            <strong>{key.label}</strong>
                            <code>{key.prefix}…</code>
                            <time dateTime={new Date(key.createdAt).toISOString()}>
                              {new Date(key.createdAt).toLocaleDateString()}
                            </time>
                          </div>
                          <button
                            type="button"
                            disabled={keyOperation !== null}
                            onClick={() => void revokeKey(key)}
                          >
                            Revoke
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : keys ? (
                    <p className="api-key-empty">No API keys.</p>
                  ) : null}
                </div>
              </section>
            </>
          ) : (
            <div className="account-auth-actions">
              <p>Sign in with your passkey, or explicitly start a separate account.</p>
              <button
                className="account-primary-action"
                type="button"
                disabled={session.operation !== null}
                onClick={() => void session.signIn()}
              >
                Sign in with passkey
              </button>
              <button
                type="button"
                disabled={session.operation !== null}
                onClick={() => void session.startNewAccount()}
              >
                Start new account
              </button>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
}

function decodeApiKey(value: unknown): ApiKeyMetadata {
  if (!isRecord(value)) throw new Error("Invalid API key response.");
  const { id, label, prefix, createdAt } = value;
  if (
    typeof id !== "string"
    || !API_KEY_ID.test(id)
    || typeof label !== "string"
    || typeof prefix !== "string"
    || typeof createdAt !== "number"
    || !Number.isFinite(createdAt)
  ) throw new Error("Invalid API key response.");
  return { id, label, prefix, createdAt };
}

function decodeCredentialStatus(value: unknown): CredentialStatus {
  if (!isRecord(value) || !isRecord(value.openai) || !isRecord(value.chatgpt)) {
    throw new Error("Invalid model connection response.");
  }
  const active = value.active === "openai" || value.active === "chatgpt" ? value.active : null;
  if (typeof value.ready !== "boolean"
    || typeof value.openai.connected !== "boolean"
    || typeof value.chatgpt.connected !== "boolean") {
    throw new Error("Invalid model connection response.");
  }
  const login = value.chatgpt.login === undefined
    ? undefined
    : decodeChatGptLogin(value.chatgpt.login);
  return {
    ready: value.ready,
    active,
    openai: { connected: value.openai.connected },
    chatgpt: {
      connected: value.chatgpt.connected,
      ...(typeof value.chatgpt.account_id === "string" ? { accountId: value.chatgpt.account_id } : {}),
      ...(login ? { login } : {}),
    },
  };
}

function decodeChatGptLogin(value: unknown): NonNullable<CredentialStatus["chatgpt"]["login"]> {
  if (!isRecord(value)
    || value.state !== "pending"
    || typeof value.verification_url !== "string"
    || typeof value.user_code !== "string"
    || typeof value.expires_at !== "number"
    || typeof value.poll_after_ms !== "number") {
    throw new Error("Invalid ChatGPT sign-in response.");
  }
  return {
    verificationUrl: value.verification_url,
    userCode: value.user_code,
    expiresAt: value.expires_at,
    pollAfterMs: value.poll_after_ms,
  };
}

function shortIdentity(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function failureMessage(cause: unknown, fallback: string): string {
  return clientFailureMessage(cause, fallback);
}

function notifyModelCredentialChanged(): void {
  deploymentHealth.invalidate();
  window.dispatchEvent(new Event("nanocodex:model-credential-changed"));
}
