import { Provider, Storage, webAuthn } from "accounts";
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe, StripeElements } from "@stripe/stripe-js";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Dialog } from "nanocodex/connect";

import {
  AccountChooser,
  type AccountSelection,
  type StoredPasskey,
} from "./AccountChooser";

import { classifyMachineUsdOrder } from "./machineUsdOrder.mjs";
import {
  accountLoginCapabilities,
  appVisibilityPermissions,
  chatGptConnectorDisposition,
  connectorApprovalDisposition,
  connectApiOrigin,
  createMcpCallbackContinuation,
  deviceMcpReturnPath,
  focusedConnectorFromResources,
  focusedMcpConnection,
  isLocalDevelopmentOrigin,
  mcpConnectionApprovalDisposition,
  mcpConnectionsFromWire,
  registeredApp,
  restoreMcpCallbackContinuation,
  sanitizeCliWalletResult,
  sanitizeWalletResult,
  signedAppResources,
  usesBrowserLocalWebAuthn,
} from "./connectPolicy.mjs";
import type { ConnectRequest, McpConnection, WalletRequest } from "./connectTypes";
const browserLocalWebAuthn = usesBrowserLocalWebAuthn(window.location.origin);
const provider = createProvider(browserLocalWebAuthn);
const providerStore = (provider as unknown as {
  store: {
    getState(): { accounts: readonly ProviderStoreAccount[] };
    subscribe(listener: () => void): () => void;
  };
}).store;
let browserSession: Promise<BrowserSession> | undefined;

export async function logoutAccount() {
  try {
    await provider.request({ method: "wallet_disconnect" });
  } finally {
    invalidateBrowserSession();
  }
}

const connectorIds = ["github", "gmail", "gdrive", "x", "chatgpt"] as const;
const connectDialogRoutingHeaders = { "x-nanocodex-connect-client": "onboarding" } as const;
const connectDeviceRoutingHeaders = { "x-nanocodex-connect-client": "device" } as const;
const connectorResourcePrefix = "urn:nanocodex:connector:";
const connectorsResourcePrefix = "urn:nanocodex:connectors:";
const mcpConnectionResourcePrefix = "urn:nanocodex:mcp:";
const mcpFocusResourcePrefix = "urn:nanocodex:mcp-focus:";
const hostedAuthorizationResource = "urn:nanocodex:authorization:hosted";
const productionNanocodexOrigin = "https://nanocodex.gakonst.workers.dev";
const mcpCallbackContinuationPrefix = "nanocodex:mcp-callback:";
type ConnectorId = typeof connectorIds[number];
type ConnectorStatus = Readonly<{
  connected: boolean;
  account_id?: string | undefined;
  label?: string | undefined;
}>;
type ConnectorStatuses = Partial<Record<ConnectorId, ConnectorStatus>>;
type PendingApproval = Readonly<{
  accountAddress: `0x${string}`;
  apiUrl: string;
  result: unknown;
  requestId: string;
  requestedConnectors: readonly ConnectorId[];
  requestedMcpConnections: readonly McpConnection[];
  token: string;
}>;
type ConnectorAttempt = {
  abort: AbortController;
  connector: ConnectorId;
  expiryTimer?: number | undefined;
  popup?: Window | undefined;
  popupCheck?: number | undefined;
  popupClosed?: number | undefined;
  requestId: string;
  token: string;
};
type CeremonyAttempt = Readonly<{ requestId: string }>;
type BrowserSession = Readonly<{ id: string; persistent: boolean }>;
type ProviderStoreAccount = Readonly<{
  address: `0x${string}`;
  credential?: Readonly<{ id: string }> | undefined;
  label?: string | undefined;
}>;
type WizardAccountSelection = AccountSelection;

export type { ConnectRequest } from "./connectTypes";

export type ConnectOnboardingHost = Readonly<{
  reject(error?: unknown): Promise<unknown>;
  respond(result: unknown): Promise<unknown>;
}>;

export function ConnectOnboarding({
  host,
  presentation = "dialog",
  request,
}: Readonly<{
  host: ConnectOnboardingHost;
  presentation?: "dialog" | "wizard";
  request: ConnectRequest | undefined;
}>) {
  const wizard = presentation === "wizard";
  const connectRoutingHeaders = wizard ? connectDeviceRoutingHeaders : connectDialogRoutingHeaders;
  const requestPolicyError = walletRequestPolicyError(request);
  const [ceremonyRequestId, setCeremonyRequestId] = useState<string>();
  const [failure, setFailure] = useState<Readonly<{ id: string; message: string }>>();
  const [accountMode, setAccountMode] = useState<"login" | "register">("login");
  const [wizardAccount, setWizardAccount] = useState<WizardAccountSelection>();
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [connectorStatuses, setConnectorStatuses] = useState<ConnectorStatuses>();
  const [connectorAction, setConnectorAction] = useState<ConnectorId>();
  const [mcpConnections, setMcpConnections] = useState<readonly McpConnection[]>();
  const [mcpConnectionAction, setMcpConnectionAction] = useState<string>();
  const [completedRequestId, setCompletedRequestId] = useState<string>();
  const [settlingRequestId, setSettlingRequestId] = useState<string>();
  const [deviceCode, setDeviceCode] = useState<Readonly<{
    code: string;
    expiresAt?: number | undefined;
    url: string;
  }>>();
  const activeConnector = useRef<ConnectorAttempt | undefined>(undefined);
  const activeCeremony = useRef<CeremonyAttempt | undefined>(undefined);
  const automaticallyStartedRequestId = useRef<string | undefined>(undefined);
  const currentRequestId = useRef<string | undefined>(undefined);
  const providerAccounts = useSyncExternalStore(
    providerStore.subscribe,
    () => providerStore.getState().accounts,
    () => providerStore.getState().accounts,
  );
  const storedPasskeys = useMemo(() => providerAccounts.flatMap((account) => {
    if (!("credential" in account) || !account.credential?.id) return [];
    return [{
      address: account.address,
      credentialId: account.credential.id,
      label: account.label,
    } satisfies StoredPasskey];
  }), [providerAccounts]);
  currentRequestId.current = request?.id;

  const finishConnectorAttempt = useCallback((attempt: ConnectorAttempt, closePopup = true) => {
    if (activeConnector.current !== attempt) return false;
    activeConnector.current = undefined;
    attempt.abort.abort();
    if (attempt.expiryTimer !== undefined) window.clearTimeout(attempt.expiryTimer);
    if (attempt.popupCheck !== undefined) window.clearInterval(attempt.popupCheck);
    if (attempt.popupClosed !== undefined) window.clearTimeout(attempt.popupClosed);
    if (closePopup && attempt.popup && !attempt.popup.closed) attempt.popup.close();
    setConnectorAction(undefined);
    setMcpConnections(undefined);
    setMcpConnectionAction(undefined);
    setCompletedRequestId(undefined);
    setSettlingRequestId(undefined);
    return true;
  }, []);

  useEffect(() => {
    const previous = activeConnector.current;
    if (previous) finishConnectorAttempt(previous);
    setAccountMode("login");
    setWizardAccount(undefined);
    setPendingApproval(undefined);
    setConnectorStatuses(undefined);
    setConnectorAction(undefined);
    setDeviceCode(undefined);
  }, [request?.id, finishConnectorAttempt]);

  useEffect(() => () => {
    const attempt = activeConnector.current;
    if (attempt) {
      activeConnector.current = undefined;
      attempt.abort.abort();
      if (attempt.expiryTimer !== undefined) window.clearTimeout(attempt.expiryTimer);
      if (attempt.popupCheck !== undefined) window.clearInterval(attempt.popupCheck);
      if (attempt.popupClosed !== undefined) window.clearTimeout(attempt.popupClosed);
      if (attempt.popup && !attempt.popup.closed) attempt.popup.close();
    }
  }, []);

  useEffect(() => {
    if (!request || request.type !== "walletConnect") return;
    if (request.returnedConnectorResult === "cancelled") {
      setFailure({ id: request.id, message: "The account authorization was cancelled. Connect again when you are ready." });
    } else if (request.returnedConnectorResult === "failed") {
      setFailure({ id: request.id, message: "The account provider could not complete authorization. Try connecting again." });
    } else if (request.returnedMcpResult === "cancelled") {
      setFailure({ id: request.id, message: "The MCP authorization was cancelled. Connect again when you are ready." });
    } else if (request.returnedMcpResult === "failed") {
      setFailure({ id: request.id, message: "The MCP provider could not complete authorization. Try connecting again." });
    }
  }, [request?.id, request?.type === "walletConnect" ? request.returnedConnectorResult : undefined,
    request?.type === "walletConnect" ? request.returnedMcpResult : undefined]);

  useEffect(() => {
    if (!request || request.type !== "walletConnect"
      || (!request.returnedConnector && !request.returnedMcpConnection)) return;
    const key = mcpCallbackContinuationKey(request.id);
    const serialized = window.sessionStorage.getItem(key);
    window.sessionStorage.removeItem(key);
    if (!serialized) return;
    try {
      const view = walletView(request);
      const restored = restoreMcpCallbackContinuation(JSON.parse(serialized), {
        requestId: request.id,
        apiUrl: connectApiUrl(request),
        returnedConnector: request.returnedConnector,
        returnedMcpConnection: request.returnedMcpConnection,
        requestedConnectors: requestedConnectorIdsFromResources(view.auth.resources),
        requestedMcpConnections: view.mcpConnections,
      });
      const approval: PendingApproval = {
        accountAddress: restored.accountAddress,
        apiUrl: restored.apiUrl,
        result: restored.result,
        requestId: restored.requestId,
        requestedConnectors: restored.requestedConnectors,
        requestedMcpConnections: restored.requestedMcpConnections,
        token: restored.token,
      };
      setPendingApproval(approval);
      setConnectorStatuses(undefined);
      setMcpConnections(view.mcpConnections);
      void refreshConnectors(approval);
    } catch (error) {
      setFailure({ id: request.id, message: errorMessage(error) });
    }
  }, [request?.id, request?.type === "walletConnect" ? request.returnedConnector : undefined,
    request?.type === "walletConnect" ? request.returnedMcpConnection : undefined]);

  useEffect(() => {
    if (
      !wizard
      || request?.type !== "walletConnect"
      || !allowsAutomaticSavedAccount(request)
      || request.returnedConnector
      || request.returnedConnectorResult
      || request.returnedMcpConnection
      || request.returnedMcpResult
      || storedPasskeys.length !== 1
      || automaticallyStartedRequestId.current === request.id
    ) return;
    const account = storedPasskeys[0]!;
    const selection: WizardAccountSelection = {
      mode: "login",
      label: account.label || shortAddress(account.address),
      address: account.address,
      credentialId: account.credentialId,
    };
    automaticallyStartedRequestId.current = request.id;
    setWizardAccount(selection);
    void ensureBrowserSession().then((session) => {
      if (currentRequestId.current !== request.id) return;
      void approve(selection, session.persistent);
    }).catch((error) => {
      if (currentRequestId.current === request.id) {
        setFailure({ id: request.id, message: errorMessage(error) });
      }
    });
  }, [request?.id, request?.type === "walletConnect" ? request.returnedConnector : undefined,
    request?.type === "walletConnect" ? request.returnedConnectorResult : undefined,
    request?.type === "walletConnect" ? request.returnedMcpConnection : undefined,
    request?.type === "walletConnect" ? request.returnedMcpResult : undefined, storedPasskeys, wizard]);

  useEffect(() => {
    if (!pendingApproval) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const attempt = activeConnector.current;
      if (
        !attempt
        || attempt.connector === "chatgpt"
        || event.origin !== pendingApproval.apiUrl
        || event.source !== attempt.popup
        || !isConnectorCompletion(event.data)
        || event.data.connector !== attempt.connector
      ) return;
      if (event.data.result !== "success") {
        if (finishConnectorAttempt(attempt)) {
          setFailure({
            id: attempt.requestId,
            message: event.data.error ?? event.data.message ?? "The account provider did not complete the connection.",
          });
        }
        return;
      }
      stopPopupMonitor(attempt);
      void (async () => {
        try {
          const state = await refreshConnectors(pendingApproval);
          if (!state.connectors[attempt.connector]?.connected) {
            throw new Error("The account provider completed without connecting the requested account.");
          }
        } catch (error) {
          if (activeConnector.current === attempt) {
            setFailure({ id: attempt.requestId, message: errorMessage(error) });
          }
        } finally {
          finishConnectorAttempt(attempt);
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pendingApproval, finishConnectorAttempt]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || ceremonyRequestId === request.id) return;
      event.preventDefault();
      reject();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request?.id, ceremonyRequestId]);

  useEffect(() => {
    if (!request || !requestPolicyError) return;
    void host.reject(new Error(requestPolicyError));
  }, [host, request?.id, requestPolicyError]);

  useEffect(() => {
    if (
      !request
      || request.type !== "walletConnect"
      || accountMode !== "register"
      || browserLocalWebAuthn
    ) return;
    void ensureBrowserSession().catch((error) => {
      if (currentRequestId.current === request.id) {
        setFailure({ id: request.id, message: errorMessage(error) });
      }
    });
  }, [request?.id, accountMode]);

  useEffect(() => {
    if (
      !pendingApproval
      || !connectorStatuses
      || !mcpConnections
      || !approvalReady(pendingApproval, connectorStatuses, mcpConnections)
      || ceremonyRequestId === pendingApproval.requestId
      || connectorAction
      || mcpConnectionAction
    ) return;
    const completed = pendingApproval;
    setSettlingRequestId(completed.requestId);
    void host.respond(completed.result).then(() => {
      if (currentRequestId.current !== completed.requestId) return;
      clearMcpCallbackContinuation(completed.requestId);
      setCompletedRequestId(completed.requestId);
    }).catch((error) => {
      if (currentRequestId.current === completed.requestId) {
        setSettlingRequestId(undefined);
        setFailure({ id: completed.requestId, message: errorMessage(error) });
      }
    });
  }, [connectorAction, connectorStatuses, mcpConnectionAction, mcpConnections, pendingApproval, ceremonyRequestId, host]);

  if (!request || requestPolicyError) return null;
  if (request.type === "deviceError" || request.type === "deviceComplete") {
    const complete = request.type === "deviceComplete";
    return (
      <section
        className={`connect-onboarding ${wizard ? "connect-wizard" : "dialog-shell"}`}
        data-request={request.type}
        data-testid={complete ? "device-connect-complete" : "device-connect-error"}
      >
        {!wizard ? <header className="dialog-header">
          <span className="wordmark">nanocodex/connect</span>
          <span className="secure-label"><span aria-hidden="true" /> device</span>
        </header> : null}
        <div className={wizard ? "wizard-content wizard-complete" : "dialog-content"}>
          <section className="request-title" aria-labelledby="device-error-heading">
            <h1 id="device-error-heading">{complete
              ? request.status === "approved"
                ? request.connectorName ? `${request.connectorName} connected` : "Installation approved"
                : request.connectorName ? `${request.connectorName} not connected` : "Installation not approved"
              : "Device authorization unavailable"}</h1>
            <p className="request-copy">{complete
              ? "Return to the terminal to continue."
              : <>Start a new <code>nanocodex login</code> request in the terminal.</>}</p>
            {wizard && complete && request.status === "approved" ? (
              <div className="completion-actions">
                <a href="/connect">Connect more accounts</a>
              </div>
            ) : null}
          </section>
          {!complete ? <p className="dialog-error" role="alert">{request.message}</p> : null}
        </div>
      </section>
    );
  }

  const ceremonyActive = ceremonyRequestId === request.id;

  async function completeRequest(result: unknown, requestId: string) {
    setSettlingRequestId(requestId);
    try {
      await host.respond(result);
      if (currentRequestId.current === requestId) setCompletedRequestId(requestId);
    } catch (error) {
      if (currentRequestId.current === requestId) setSettlingRequestId(undefined);
      throw error;
    }
  }

  async function approve(
    selectedAccount?: WizardAccountSelection,
    authenticatedSavedAccount = false,
  ) {
    const activeRequest = request;
    if (!activeRequest
      || activeRequest.type === "deviceError"
      || activeRequest.type === "deviceComplete"
      || activeCeremony.current) return;
    setFailure(undefined);
    if (activeRequest.type === "machineUsdFund") return;

    const focusedConnector = activeRequest.type === "walletConnect" && wizard
      ? walletView(activeRequest).focusConnector
      : undefined;
    const focusedMcp = activeRequest.type === "walletConnect" && wizard
      ? walletView(activeRequest).focusMcpConnection
      : undefined;

    const attempt: CeremonyAttempt = { requestId: activeRequest.id };
    activeCeremony.current = attempt;
    setCeremonyRequestId(activeRequest.id);
    try {
      const selectedMode = selectedAccount?.mode ?? accountMode;
      const hostedAuthorization = activeRequest.type === "walletConnect"
        && (selectedMode === "register" || authenticatedSavedAccount)
        && activeRequest.confirmationCode !== undefined
        && walletConnectContext(activeRequest).resources.includes(hostedAuthorizationResource)
        && !walletConnectContext(activeRequest).resources.includes("urn:nanocodex:mpp:machusd:spend");
      if (authenticatedSavedAccount && (!hostedAuthorization
        || selectedMode !== "login"
        || !selectedAccount?.address)) {
        throw new Error("This saved account requires passkey authentication.");
      }
      setAccountMode(selectedMode);
      let registrationUserId: string | undefined;
      if (
        activeRequest.type === "walletConnect"
        && selectedMode === "register"
        && !browserLocalWebAuthn
      ) {
        registrationUserId = await prepareRegistrationSession();
      }
      let result: undefined | { accounts: readonly Readonly<{ address: `0x${string}` }>[] };
      if (authenticatedSavedAccount) {
        result = { accounts: [{ address: selectedAccount!.address! }] };
      } else {
        try {
          if (activeRequest.type === "walletConnect"
            && browserLocalWebAuthn
            && selectedAccount?.discoverCredential) {
            await clearPortableCredential(connectApiUrl(activeRequest));
          }
          result = await provider.request(
            (activeRequest.type === "walletConnect"
              ? walletRequest(
                  activeRequest,
                  selectedMode,
                  registrationUserId,
                  selectedAccount?.credentialId,
                  selectedAccount?.label,
                  selectedAccount?.discoverCredential,
                  hostedAuthorization,
                )
              : activeRequest.rpc) as never,
          ) as typeof result;
        } finally {
          if (activeRequest.type === "walletConnect") invalidateBrowserSession();
        }
      }
      if (currentRequestId.current !== attempt.requestId) {
        throw new DOMException("The Connect request changed.", "AbortError");
      }
      if (activeRequest.type === "walletConnect" && !result?.accounts[0]) {
        throw new Error("Accounts did not return a connected account.");
      }
      if (activeRequest.type === "walletConnect") {
        const account = result!.accounts[0] as Readonly<{
          address: `0x${string}`;
          capabilities?: Readonly<{ auth?: Readonly<{
            connectors?: ConnectorStatuses;
            mcp_connections?: readonly McpConnection[];
            profile?: Readonly<{ linked?: boolean }>;
            token?: string;
          }> }>;
        }>;
        const auth = account.capabilities?.auth;
        if (hostedAuthorization) {
          const hosted = await authorizeHostedRegistration(activeRequest, account.address);
          const next: PendingApproval = {
            accountAddress: account.address,
            apiUrl: connectApiUrl(activeRequest),
            result: sanitizeCliWalletResult({
              accounts: [{
                address: account.address,
                capabilities: {
                  auth: { approval_id: hosted.approvalId, mode: "hosted" },
                },
              }],
            }),
            requestId: activeRequest.id,
            requestedConnectors: requestedConnectorIdsFromResources(
              walletConnectContext(activeRequest).resources,
            ),
            requestedMcpConnections: walletView(activeRequest).mcpConnections,
            token: hosted.token,
          };
          setConnectorStatuses(hosted.connectors);
          setMcpConnections(hosted.mcpConnections);
          if (approvalReady(next, hosted.connectors, hosted.mcpConnections)) {
            await completeRequest(next.result, next.requestId);
            return;
          }
          setPendingApproval(next);
          if (focusedConnector) {
            void connectDeviceConnector(next, hosted.connectors, focusedConnector);
          } else if (focusedMcp) {
            void connectMcpConnection(next, hosted.mcpConnections, focusedMcp, true);
          }
          return;
        }
        const token = auth?.token;
        if (!token) throw new Error("Accounts did not return an authenticated Connect session.");
        const next: PendingApproval = {
          accountAddress: account.address,
          apiUrl: connectApiUrl(activeRequest),
          result: activeRequest.confirmationCode
            ? sanitizeCliWalletResult(result)
            : sanitizeWalletResult(result),
          requestId: activeRequest.id,
          requestedConnectors: requestedConnectorIdsFromResources(
            walletConnectContext(activeRequest).resources,
          ),
          requestedMcpConnections: walletView(activeRequest).mcpConnections,
          token,
        };
        if (auth?.connectors && auth.profile?.linked === true) {
          const authenticatedMcpConnections = requestedMcpConnections(
            next.requestedMcpConnections,
            auth.mcp_connections,
          );
          setConnectorStatuses(auth.connectors);
          setMcpConnections(authenticatedMcpConnections);
          if (approvalReady(next, auth.connectors, authenticatedMcpConnections)) {
            await completeRequest(next.result, next.requestId);
            return;
          }
          setPendingApproval(next);
          if (focusedConnector) {
            void connectDeviceConnector(next, auth.connectors, focusedConnector);
          } else if (focusedMcp) {
            void connectMcpConnection(next, authenticatedMcpConnections, focusedMcp, true);
          }
          return;
        }
        const accountState = await authorizeNanocodexAccount(next);
        if (approvalReady(next, accountState.connectors, accountState.mcpConnections)) {
          await completeRequest(next.result, next.requestId);
          return;
        }
        setPendingApproval(next);
        if (focusedConnector) {
          void connectDeviceConnector(next, accountState.connectors, focusedConnector);
        } else if (focusedMcp) {
          void connectMcpConnection(next, accountState.mcpConnections, focusedMcp, true);
        }
        return;
      }
      await completeRequest(result, activeRequest.id);
    } catch (error) {
      if (currentRequestId.current === attempt.requestId) {
        setFailure({ id: activeRequest.id, message: errorMessage(error) });
      }
    } finally {
      if (activeCeremony.current === attempt) {
        activeCeremony.current = undefined;
        setCeremonyRequestId(undefined);
      }
    }
  }

  async function refreshConnectors(approval: PendingApproval) {
    const response = await fetch(`${approval.apiUrl}/v1/connectors`, {
      headers: {
        authorization: `Bearer ${approval.token}`,
        ...connectRoutingHeaders,
      },
    });
    const body = await response.json() as Readonly<{
      connectors?: ConnectorStatuses;
      profile?: Readonly<{ linked?: boolean }>;
    }> & Record<string, any>;
    if (!response.ok || !body.connectors) {
      throw new Error(apiError(body, "Unable to read connected accounts."));
    }
    if (currentRequestId.current !== approval.requestId) {
      throw new DOMException("The Connect request changed.", "AbortError");
    }
    setConnectorStatuses(body.connectors);
    if (body.connectors.chatgpt?.connected) setDeviceCode(undefined);
    return { connectors: body.connectors };
  }

  async function authorizeNanocodexAccount(approval: PendingApproval): Promise<Readonly<{
    connectors: ConnectorStatuses;
    mcpConnections: readonly McpConnection[];
  }>> {
    const start = await fetch(`${approval.apiUrl}/v1/account-link`, {
      method: "POST",
      headers: { authorization: `Bearer ${approval.token}` },
    });
    const started = await start.json() as Record<string, unknown>;
    if (!start.ok) throw new Error(apiError(started, "Unable to authorize your Nanocodex account."));
    const authorizationUrl = new URL(requiredUrl(started.authorization_url));
    const state = opaqueToken(started.state, "account-link state");
    if (authorizationUrl.origin !== nanocodexOriginFor(approval.apiUrl)
      || authorizationUrl.pathname !== "/v1/connect/account-link"
      || authorizationUrl.searchParams.get("state") !== state) {
      throw new Error("The Nanocodex account authorization is invalid.");
    }

    authorizationUrl.pathname = "/v1/connect/account-link/authorize";
    const authorize = await fetch(authorizationUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    const authorized = await authorize.json() as Record<string, unknown>;
    if (!authorize.ok) throw new Error(apiError(authorized, "Unable to authorize your Nanocodex account."));
    const code = opaqueToken(authorized.code, "account-link code");
    if (opaqueToken(authorized.state, "account-link state") !== state) {
      throw new Error("The Nanocodex account authorization state changed.");
    }

    const complete = await fetch(`${approval.apiUrl}/v1/account-link`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${approval.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code, state }),
    });
    const completed = await complete.json() as Readonly<{
      connectors?: ConnectorStatuses;
      linked?: boolean;
      mcp_connections?: unknown;
    }> & Record<string, any>;
    if (!complete.ok || completed.linked !== true || !completed.connectors) {
      throw new Error(apiError(completed, "Unable to authorize your Nanocodex account."));
    }
    if (currentRequestId.current !== approval.requestId) {
      throw new DOMException("The Connect request changed.", "AbortError");
    }
    setConnectorStatuses(completed.connectors);
    const completedMcpConnections = requestedMcpConnections(
      approval.requestedMcpConnections,
      completed.mcp_connections,
    );
    setMcpConnections(completedMcpConnections);
    if (completed.connectors.chatgpt?.connected) setDeviceCode(undefined);
    return { connectors: completed.connectors, mcpConnections: completedMcpConnections };
  }

  async function authorizeHostedRegistration(
    activeRequest: WalletRequest,
    accountAddress: `0x${string}`,
  ): Promise<{
    approvalId: string;
    connectors: ConnectorStatuses;
    mcpConnections: readonly McpConnection[];
    token: string;
  }> {
    const resources = walletConnectContext(activeRequest).resources;
    const websiteOrigin = nanocodexOriginFor(connectApiUrl(activeRequest));
    const authorize = await fetch(`${websiteOrigin}/v1/connect/hosted-authorization/authorize`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account_address: accountAddress,
        app_id: "nanocodex-cli",
        app_origin: "https://cli.nanocodex.xyz",
        resources,
      }),
    });
    const authorized = await authorize.json() as Record<string, unknown>;
    if (!authorize.ok) {
      throw new Error(apiError(authorized, "Unable to authorize this hosted Nanocodex account."));
    }
    const code = opaqueToken(authorized.code, "hosted authorization code");
    const exchange = await fetch(`${connectApiUrl(activeRequest)}/v1/hosted-authorizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...connectRoutingHeaders,
      },
      body: JSON.stringify({
        account_address: accountAddress,
        app_id: "nanocodex-cli",
        app_origin: "https://cli.nanocodex.xyz",
        code,
        resources,
      }),
    });
    const exchanged = await exchange.json() as Readonly<{
      account_address?: string;
      approval_id?: string;
      connectors?: ConnectorStatuses;
      mcp_connections?: unknown;
      profile?: Readonly<{ linked?: boolean }>;
      token?: string;
    }> & Record<string, unknown>;
    if (!exchange.ok
      || exchanged.account_address?.toLowerCase() !== accountAddress.toLowerCase()
      || !exchanged.connectors
      || exchanged.profile?.linked !== true
      || typeof exchanged.approval_id !== "string"
      || typeof exchanged.token !== "string") {
      throw new Error(apiError(exchanged, "Unable to create the hosted Nanocodex authorization."));
    }
    return {
      approvalId: exchanged.approval_id,
      connectors: exchanged.connectors,
      mcpConnections: requestedMcpConnections(
        walletView(activeRequest).mcpConnections,
        exchanged.mcp_connections,
      ),
      token: exchanged.token,
    };
  }

  async function connectDeviceConnector(
    approval: PendingApproval,
    statuses: ConnectorStatuses,
    id: ConnectorId,
  ) {
    if (activeConnector.current || statuses[id]?.connected) return;
    setFailure(undefined);
    setConnectorAction(id);
    try {
      const response = await fetch(`${approval.apiUrl}/v1/connectors/${id}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${approval.token}`,
          "content-type": "application/json",
          ...connectDeviceRoutingHeaders,
        },
        body: JSON.stringify({ return_to: deviceReturnPath() }),
      });
      const body = await response.json() as Record<string, any>;
      if (!response.ok) throw new Error(apiError(body, `Unable to connect ${id}.`));
      if (id === "chatgpt") {
        const disposition = chatGptConnectorDisposition(body);
        if (disposition !== "connected") {
          throw new Error(disposition === "device"
            ? "This ChatGPT login needs an interactive provider ceremony. Use the Account page to continue."
            : "The broker returned an invalid ChatGPT connection status.");
        }
        setConnectorStatuses({
          ...statuses,
          chatgpt: {
            connected: true,
            ...(typeof body.account_id === "string" ? { account_id: body.account_id } : {}),
          },
        });
        setConnectorAction(undefined);
        return;
      }
      const authorizationUrl = requiredUrl(body.authorization_url);
      const continuation = createMcpCallbackContinuation({
        requestId: approval.requestId,
        apiUrl: approval.apiUrl,
        accountAddress: approval.accountAddress,
        token: approval.token,
        requestedConnectors: approval.requestedConnectors,
        requestedMcpConnections: approval.requestedMcpConnections,
        connectorStatuses: statuses,
        result: approval.result,
      });
      window.sessionStorage.setItem(
        mcpCallbackContinuationKey(approval.requestId),
        JSON.stringify(continuation),
      );
      window.location.assign(authorizationUrl);
    } catch (error) {
      if (currentRequestId.current === approval.requestId && !isAbortError(error)) {
        setConnectorAction(undefined);
        setFailure({ id: approval.requestId, message: errorMessage(error) });
      }
    }
  }

  async function connectMcpConnection(
    approval: PendingApproval,
    connections: readonly McpConnection[],
    id: string,
    automatic = false,
  ) {
    const current = connections.find((connection) => connection.id === id);
    if (!current || current.status === "connected" || mcpConnectionAction || connectorAction) return;
    if (automatic && request?.type === "walletConnect" && request.returnedMcpConnection === id) return;
    setFailure(undefined);
    setMcpConnectionAction(id);
    try {
      const response = await fetch(`${approval.apiUrl}/v1/mcp-connections/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${approval.token}`,
          "content-type": "application/json",
          ...connectRoutingHeaders,
        },
        body: JSON.stringify(wizard ? {
          return_to: deviceReturnPath(),
        } : {}),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(apiError(body, `Unable to connect ${current.name}.`));
      const connection = mcpConnectionFromStartResponse(body, id);
      const updated = replaceMcpConnection(connections, connection);
      setMcpConnections(updated);
      if (connection.status === "connected") {
        setMcpConnectionAction(undefined);
        return;
      }
      const authorizationUrl = requiredUrl(body.authorization_url);
      const continuation = createMcpCallbackContinuation({
        requestId: approval.requestId,
        apiUrl: approval.apiUrl,
        accountAddress: approval.accountAddress,
        token: approval.token,
        requestedConnectors: approval.requestedConnectors,
        requestedMcpConnections: approval.requestedMcpConnections,
        connectorStatuses: connectorStatuses ?? {},
        result: approval.result,
      });
      window.sessionStorage.setItem(
        mcpCallbackContinuationKey(approval.requestId),
        JSON.stringify(continuation),
      );
      window.location.assign(authorizationUrl);
    } catch (error) {
      if (currentRequestId.current === approval.requestId && !isAbortError(error)) {
        setMcpConnectionAction(undefined);
        setFailure({ id: approval.requestId, message: errorMessage(error) });
      }
    }
  }

  async function connectConnector(id: ConnectorId) {
    if (
      !pendingApproval
      || ceremonyActive
      || connectorAction
      || !connectorStatuses
      || connectorStatuses[id]?.connected
    ) return;
    if (wizard) {
      await connectDeviceConnector(pendingApproval, connectorStatuses, id);
      return;
    }
    const popup = id === "chatgpt"
      ? undefined
      : window.open("about:blank", "nanocodex-connect-oauth", "popup,width=520,height=720") ?? undefined;
    if (id !== "chatgpt" && !popup) {
      setFailure({
        id: pendingApproval.requestId,
        message: "The account authorization popup was blocked. Allow popups and try again.",
      });
      return;
    }
    await startConnector(pendingApproval, connectorStatuses, id, popup);
  }

  async function connectRequestedMcp(id: string) {
    if (!pendingApproval || ceremonyActive || connectorAction || mcpConnectionAction || !mcpConnections) return;
    await connectMcpConnection(pendingApproval, mcpConnections, id);
  }

  async function startConnector(
    approval: PendingApproval,
    statuses: ConnectorStatuses,
    id: ConnectorId,
    popup: Window | undefined,
  ) {
    if (
      activeConnector.current
      || statuses[id]?.connected
      || (id !== "chatgpt" && (!popup || popup.closed))
    ) {
      popup?.close();
      if (!statuses[id]?.connected && currentRequestId.current === approval.requestId) {
        setFailure({
          id: approval.requestId,
          message: `The ${connectorDefinition(id).name} window closed before the connection started. Try again.`,
        });
      }
      return;
    }
    setFailure(undefined);
    const attempt: ConnectorAttempt = {
      abort: new AbortController(),
      connector: id,
      popup,
      requestId: approval.requestId,
      token: crypto.randomUUID(),
    };
    activeConnector.current = attempt;
    setConnectorAction(id);
    if (id !== "chatgpt") monitorPopup(attempt);
    try {
      const response = await fetch(`${approval.apiUrl}/v1/connectors/${id}`, {
        method: "POST",
      headers: {
        authorization: `Bearer ${approval.token}`,
        "content-type": "application/json",
        ...connectRoutingHeaders,
        },
        body: JSON.stringify(wizard ? { return_to: deviceReturnPath() } : {}),
        signal: attempt.abort.signal,
      });
      const body = await response.json() as Record<string, unknown>;
      if (!isActiveConnector(activeConnector.current, attempt, currentRequestId.current)) return;
      if (!response.ok) throw new Error(apiError(body, `Unable to connect ${id}.`));
      if (id === "chatgpt") {
        const url = requiredUrl(body.verification_url);
        const code = requiredText(body.user_code, "ChatGPT device code");
        const expiresAt = requiredExpiry(body.expires_at);
        setDeviceCode({
          code,
          url,
          expiresAt,
        });
        attempt.expiryTimer = window.setTimeout(() => {
          if (finishConnectorAttempt(attempt)) {
            setDeviceCode(undefined);
            setFailure({ id: attempt.requestId, message: "The ChatGPT device code expired. Try again." });
          }
        }, expiresAt - Date.now());
        const preparedChatGptPopup = popup && !popup.closed ? popup : undefined;
        const chatGptPopup = preparedChatGptPopup
          ?? window.open(url, "nanocodex-connect-chatgpt", "popup,width=520,height=720")
          ?? undefined;
        if (!chatGptPopup) {
          setFailure({
            id: attempt.requestId,
            message: "The ChatGPT popup was blocked. Open the verification link below to continue.",
          });
        } else {
          attempt.popup = chatGptPopup;
          if (preparedChatGptPopup) preparedChatGptPopup.location.href = url;
        }
        void pollChatGpt(attempt, approval, expiresAt, pollDelay(body.poll_after_ms));
        return;
      }
      const authorizationUrl = requiredUrl(body.authorization_url);
      popup!.location.href = authorizationUrl;
    } catch (error) {
      if (finishConnectorAttempt(attempt) && !isAbortError(error)) {
        setFailure({ id: attempt.requestId, message: errorMessage(error) });
      }
    }
  }

  async function pollChatGpt(
    attempt: ConnectorAttempt,
    approval: PendingApproval,
    expiresAt: number,
    initialDelay: number,
  ) {
    let delay = initialDelay;
    try {
      for (;;) {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) throw new Error("The ChatGPT device code expired. Try again.");
        await abortableDelay(Math.min(delay, remaining), attempt.abort.signal);
        if (!isActiveConnector(activeConnector.current, attempt, currentRequestId.current)) return;
        const response = await fetch(`${approval.apiUrl}/v1/connectors/chatgpt`, {
          headers: {
            authorization: `Bearer ${approval.token}`,
            ...connectRoutingHeaders,
          },
          signal: attempt.abort.signal,
        });
        const body = await response.json() as Record<string, unknown>;
        if (!isActiveConnector(activeConnector.current, attempt, currentRequestId.current)) return;
        if (Date.now() >= expiresAt) throw new Error("The ChatGPT device code expired. Try again.");
        if (response.ok && body.connected === true) {
          await refreshConnectors(approval);
          return;
        }
        if (response.status !== 202) {
          throw new Error(apiError(body, "ChatGPT connection failed."));
        }
        delay = pollDelay(body.poll_after_ms);
      }
    } catch (error) {
      if (!isAbortError(error) && activeConnector.current === attempt) {
        setDeviceCode(undefined);
        setFailure({ id: attempt.requestId, message: errorMessage(error) });
      }
    } finally {
      finishConnectorAttempt(attempt);
    }
  }

  function monitorPopup(attempt: ConnectorAttempt) {
    attempt.popupCheck = window.setInterval(() => {
      if (activeConnector.current !== attempt || !attempt.popup?.closed) return;
      window.clearInterval(attempt.popupCheck);
      attempt.popupCheck = undefined;
      attempt.popupClosed = window.setTimeout(() => {
        if (finishConnectorAttempt(attempt, false)) {
          setFailure({ id: attempt.requestId, message: "The account authorization popup was closed before it completed." });
        }
      }, 750);
    }, 300);
  }

  function stopPopupMonitor(attempt: ConnectorAttempt) {
    if (attempt.popupCheck !== undefined) window.clearInterval(attempt.popupCheck);
    if (attempt.popupClosed !== undefined) window.clearTimeout(attempt.popupClosed);
    attempt.popupCheck = undefined;
    attempt.popupClosed = undefined;
  }

  function reject() {
    const requestId = request?.id;
    if (!requestId) return;
    clearMcpCallbackContinuation(requestId);
    const attempt = activeConnector.current;
    if (attempt) finishConnectorAttempt(attempt);
    setFailure(undefined);
    void host.reject(new Error("The request was not approved.")).catch((error) => {
      if (currentRequestId.current === requestId) {
        setFailure({ id: requestId, message: errorMessage(error) });
      }
    });
  }

  const requestCompleted = completedRequestId === request.id || settlingRequestId === request.id;
  const approvalDisabled = ceremonyActive || requestCompleted;
  const connectionRequest = request.type === "walletConnect" ? walletView(request) : undefined;

  return (
    <section
      className={`connect-onboarding ${wizard ? "connect-wizard" : "dialog-shell"}`}
      data-presentation={presentation}
      data-request={request.type}
      data-testid={wizard ? "device-connect-wizard" : "remote-connect-dialog"}
    >
      {!wizard ? <header className="dialog-header">
        <span className="wordmark">nanocodex/connect</span>
        <span className="secure-label"><span aria-hidden="true" /> passkey</span>
      </header> : null}

      {request.type === "walletConnect" ? (
        <>
          <div className={wizard ? "wizard-content" : "dialog-content"}>
            <ConnectionApproval
              accountMode={accountMode}
              connectorAction={connectorAction}
              connectorStatuses={connectorStatuses}
              completed={requestCompleted}
              confirmationCode={request.confirmationCode}
              disabled={approvalDisabled || connectorAction !== undefined || mcpConnectionAction !== undefined}
              deviceCode={deviceCode}
              mcpConnectionAction={mcpConnectionAction}
              mcpConnections={mcpConnections}
              onAccountModeChange={setAccountMode}
              onChooseAccount={(account) => {
                if (wizard) {
                  setWizardAccount(account);
                  void approve(account);
                  return;
                }
                setWizardAccount(account);
              }}
              onCancel={reject}
              onConnectConnector={connectConnector}
              onConnectMcp={connectRequestedMcp}
              accountAddress={pendingApproval?.accountAddress}
              presentation={presentation}
              request={connectionRequest!}
              selectedAccount={wizardAccount}
              storedPasskeys={storedPasskeys}
            />
            {failure?.id === request.id ? (
              <p className="dialog-error" role="alert">{failure.message}</p>
            ) : null}
          </div>
          {requestCompleted || (wizard && !pendingApproval && !wizardAccount) ? null : <div className={wizard ? "wizard-actions" : "dialog-actions"}>
            <button
              type="button"
              disabled={approvalDisabled}
              onClick={wizard && !pendingApproval ? () => setWizardAccount(undefined) : reject}
            >
              {wizard && !pendingApproval ? "Back" : "Cancel"}
            </button>
            {!pendingApproval && !wizard ? (
              <button
                type="button"
                disabled={approvalDisabled}
                onClick={() => void approve()}
              >
                {wizard
                  ? accountMode === "login" ? "Sign in with passkey" : "Create account"
                  : accountMode === "login" ? "Approve" : "Create & approve"}
              </button>
            ) : !pendingApproval && wizardAccount ? (
              <button
                type="button"
                disabled={approvalDisabled}
                onClick={() => void approve(wizardAccount)}
              >
                {connectionRequest?.focusConnector
                  ? `Connect ${connectorDefinition(connectionRequest.focusConnector).name}`
                  : connectionRequest?.focusMcpConnection
                    ? `Connect ${connectionRequest.mcpConnections.find(({ id }) => id === connectionRequest.focusMcpConnection)?.name ?? "MCP"}`
                  : "Authorize Nanocodex CLI"}
              </button>
            ) : null}
          </div>}
        </>
      ) : request.type === "walletRevokeAccessKey" ? (
        <>
          <div className="dialog-content">
            <RevocationApproval request={request} />
            {failure?.id === request.id ? (
              <p className="dialog-error" role="alert">{failure.message}</p>
            ) : null}
          </div>
          <div className="dialog-actions">
            <button type="button" disabled={ceremonyActive} onClick={reject}>Cancel</button>
            <button type="button" disabled={ceremonyActive} onClick={() => void approve()}>
              Revoke with passkey
            </button>
          </div>
        </>
      ) : (
        <FundingApproval host={host} request={request} onReject={reject} />
      )}
    </section>
  );
}

function RevocationApproval({ request }: Readonly<{ request: WalletRequest }>) {
  const params = record(firstParam(request.rpc.params));
  return (
    <>
      <section className="request-title" aria-labelledby="revocation-heading">
        <h1 id="revocation-heading">Revoke agent access</h1>
      </section>
      <section className="detail-section" aria-labelledby="revocation-details">
        <SectionHeading id="revocation-details" label="Revocation" value="One passkey" />
        <div className="permission-rows">
          <PermissionRow label="Account" value={shortAddress(params.address)} />
          <PermissionRow label="Access key" value={shortAddress(params.accessKeyAddress)} />
          <PermissionRow label="Effect" value="Immediate" />
        </div>
      </section>
    </>
  );
}

type ConnectionView = Omit<Dialog.ConnectionRequest, "auth" | "accessKey"> & Readonly<{
  auth: Readonly<{ message?: string; resources: readonly string[] }>;
  accessKey?: Omit<Dialog.ConnectionRequest["accessKey"], "witness"> & Readonly<{ witness?: `0x${string}` }>;
  focusConnector?: ConnectorId | undefined;
  focusMcpConnection?: string | undefined;
  mcpConnections: readonly McpConnection[];
}>;

function ConnectionApproval({
  accountAddress,
  accountMode,
  connectorAction,
  connectorStatuses,
  completed,
  confirmationCode,
  disabled,
  deviceCode,
  mcpConnectionAction,
  mcpConnections,
  onAccountModeChange,
  onChooseAccount,
  onCancel,
  onConnectConnector,
  onConnectMcp,
  presentation,
  request,
  selectedAccount,
  storedPasskeys,
}: Readonly<{
  accountAddress?: `0x${string}` | undefined;
  accountMode: "login" | "register";
  connectorAction?: ConnectorId | undefined;
  connectorStatuses?: ConnectorStatuses | undefined;
  completed: boolean;
  confirmationCode?: string | undefined;
  disabled: boolean;
  deviceCode?: Readonly<{ code: string; expiresAt?: number | undefined; url: string }> | undefined;
  mcpConnectionAction?: string | undefined;
  mcpConnections?: readonly McpConnection[] | undefined;
  onAccountModeChange(mode: "login" | "register"): void;
  onChooseAccount(account: WizardAccountSelection): void;
  onCancel(): void;
  onConnectConnector(id: ConnectorId): void;
  onConnectMcp(id: string): void;
  presentation: "dialog" | "wizard";
  request: ConnectionView;
  selectedAccount?: WizardAccountSelection | undefined;
  storedPasskeys: readonly StoredPasskey[];
}>) {
  const appVisibility = appVisibilityPermissions(request.auth.resources);
  if (presentation === "wizard") {
    return (
      <ConnectionWizard
        accountAddress={accountAddress}
        appVisibility={appVisibility}
        connectorAction={connectorAction}
        connectorStatuses={connectorStatuses}
        completed={completed}
        confirmationCode={confirmationCode}
        disabled={disabled}
        deviceCode={deviceCode}
        mcpConnectionAction={mcpConnectionAction}
        mcpConnections={mcpConnections}
        onChooseAccount={onChooseAccount}
        onCancel={onCancel}
        onConnectConnector={onConnectConnector}
        onConnectMcp={onConnectMcp}
        request={request}
        selectedAccount={selectedAccount}
        storedPasskeys={storedPasskeys}
      />
    );
  }
  return (
    <>
      <section className="consent-hero" aria-labelledby="approval-heading">
        <AppMark name={request.app.name} />
        <div>
          <h1 id="approval-heading">Connect to {request.app.name}</h1>
          <span>{request.accessKey ? "New key" : "Active key"}</span>
        </div>
      </section>

      {confirmationCode ? (
        <div className="terminal-code" role="status">
          <span>Confirm this code matches your terminal</span>
          <strong>{confirmationCode.slice(0, 4)}-{confirmationCode.slice(4)}</strong>
        </div>
      ) : null}

      {!connectorStatuses ? <div className="account-mode" role="group" aria-label="Nanocodex account">
        <button
          type="button"
          aria-pressed={accountMode === "login"}
          disabled={disabled}
          onClick={() => onAccountModeChange("login")}
        >
          Existing
        </button>
        <button
          type="button"
          aria-pressed={accountMode === "register"}
          disabled={disabled}
          onClick={() => onAccountModeChange("register")}
        >
          New
        </button>
      </div> : null}

      <section className="oauth-permissions" aria-label="Requested capabilities">
        <div className="capability-logos" role="list">
          {request.permission.connectors.map((connector) => {
            const id = connector.id as ConnectorId;
            const status = connectorStatuses?.[id];
            const resolved = connectorStatuses !== undefined;
            const label = `${permissionTitle(connector.id, connector.name)}. ${connectorStateLabel(
              status,
              resolved,
            )}. ${connector.detail}`;
            const className = `capability-token ${status?.connected ? "connected" : resolved ? "disconnected" : "unresolved"}`;
            const contents = <>
              <ConnectorLogo id={connector.id} name={connector.name} />
              {resolved ? <span className="connector-state" aria-hidden="true">
                {status?.connected ? "✓" : "+"}
              </span> : null}
            </>;
            return (
              <div className="capability-entry" key={connector.id} role="listitem">
                {resolved && !status?.connected ? (
                  <button
                    aria-label={label}
                    className={`${className} capability-action`}
                    data-tooltip={connectorTooltip(status, connector.detail, resolved)}
                    disabled={disabled || connectorAction !== undefined}
                    onClick={() => onConnectConnector(id)}
                    type="button"
                  >
                    {contents}
                  </button>
                ) : (
                  <div
                    aria-label={label}
                    className={className}
                    data-tooltip={connectorTooltip(status, connector.detail, resolved)}
                    tabIndex={0}
                  >
                    {contents}
                  </div>
                )}
              </div>
            );
          })}
          {request.mpp ? (
            <div
              className="capability-token"
              data-tooltip={`${formatToken(request.mpp.maxPerRequest, request.mpp.symbol)} per request · ${formatToken(request.mpp.limit, request.mpp.symbol)} per day · ${request.accessKey ? expiryLabel(request.accessKey.expiry) : "active grant"}`}
              role="listitem"
              tabIndex={0}
              aria-label={`machineUSD spend permission. ${formatToken(request.mpp.maxPerRequest, request.mpp.symbol)} per request, ${formatToken(request.mpp.limit, request.mpp.symbol)} per day.`}
            >
              <SpendLogo />
            </div>
          ) : null}
        </div>
        {appVisibility.length > 0 ? (
          <div className="app-sees" aria-label="App sees" role="list">
            <span className="app-sees-label" aria-hidden="true">App sees</span>
            {appVisibility.map((permission) => (
              <span
                aria-label={`${permission.label}: ${permission.detail}`}
                className="app-sees-permission"
                data-tooltip={permission.detail}
                key={permission.resource}
                role="listitem"
                tabIndex={0}
              >
                {permission.label}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {request.mcpConnections.length > 0 ? (
        <McpConnectionList
          action={mcpConnectionAction}
          connections={mcpConnections ?? request.mcpConnections}
          disabled={disabled}
          focusedId={request.focusMcpConnection}
          onConnect={onConnectMcp}
        />
      ) : null}

      {deviceCode ? (
        <a className="device-code" href={deviceCode.url} rel="noreferrer" target="_blank">
          <span>ChatGPT</span>
          <strong>{deviceCode.code}</strong>
        </a>
      ) : null}

      <details className="advanced-details">
        <summary>Details</summary>
        <dl className="key-details">
          <Detail label="App" value={request.app.origin} />
          {request.mpp ? <Detail label="Spend" value={`${formatToken(request.mpp.maxPerRequest, request.mpp.symbol)} / request · ${formatToken(request.mpp.limit, request.mpp.symbol)} / day`} /> : null}
          {request.accessKey ? (
            <>
              <Detail label="Key" value={request.accessKey.keyId} />
              <Detail label="Witness" value={request.accessKey.witness ?? "Bound to the SIWE challenge at approval"} />
              <Detail label="Expires" value={formatExpiry(request.accessKey.expiry)} />
            </>
          ) : <Detail label="Key" value="Reuse the app's active delegated signer" />}
        </dl>
        <ul className="resource-list" aria-label="Connect capability resources">
          {request.auth.resources.map((resource) => <li key={resource}>{resource}</li>)}
        </ul>
        {request.auth.message ? <pre>{request.auth.message}</pre> : null}
      </details>
    </>
  );
}

function ConnectionWizard({
  accountAddress,
  appVisibility,
  connectorAction,
  connectorStatuses,
  completed,
  confirmationCode,
  disabled,
  deviceCode,
  mcpConnectionAction,
  mcpConnections,
  onChooseAccount,
  onCancel,
  onConnectConnector,
  onConnectMcp,
  request,
  selectedAccount,
  storedPasskeys,
}: Readonly<{
  accountAddress?: `0x${string}` | undefined;
  appVisibility: ReturnType<typeof appVisibilityPermissions>;
  connectorAction?: ConnectorId | undefined;
  connectorStatuses?: ConnectorStatuses | undefined;
  completed: boolean;
  confirmationCode?: string | undefined;
  disabled: boolean;
  deviceCode?: Readonly<{ code: string; expiresAt?: number | undefined; url: string }> | undefined;
  mcpConnectionAction?: string | undefined;
  mcpConnections?: readonly McpConnection[] | undefined;
  onChooseAccount(account: WizardAccountSelection): void;
  onCancel(): void;
  onConnectConnector(id: ConnectorId): void;
  onConnectMcp(id: string): void;
  request: ConnectionView;
  selectedAccount?: WizardAccountSelection | undefined;
  storedPasskeys: readonly StoredPasskey[];
}>) {
  const focused = request.focusConnector ? connectorDefinition(request.focusConnector) : undefined;
  const focusedMcp = request.focusMcpConnection
    ? request.mcpConnections.find(({ id }) => id === request.focusMcpConnection)
    : undefined;
  const redirectingFocusedMcp = focusedMcp !== undefined
    && mcpConnectionAction === focusedMcp.id;
  if ((!selectedAccount && !connectorStatuses && !accountAddress) || redirectingFocusedMcp) {
    return (
      <AccountChooser
        confirmationCode={confirmationCode}
        disabled={disabled}
        onCancel={onCancel}
        onChooseAccount={onChooseAccount}
        storedPasskeys={storedPasskeys}
      />
    );
  }

  return (
    <div className="wizard-page wizard-review-page">
      <header className="wizard-intro">
        <div className="wizard-app">
          <h1>{focused ? `Connect ${focused.name}` : focusedMcp ? `Connect ${focusedMcp.name}` : "Authorize Nanocodex CLI"}</h1>
          <p>{accountAddress
            ? `Signed in as ${shortAddress(accountAddress)}. `
            : selectedAccount
              ? `${selectedAccount.mode === "register" ? "Create" : "Use"} ${selectedAccount.label}. `
            : ""}{focused
                ? connectorStatuses?.[focused.id]?.connected
                  ? `${focused.name} is connected. You can return to the terminal.`
                  : connectorAction === focused.id
                  ? `Continue in ${focused.name}. You’ll return here when it is connected.`
                  : "Continue with your passkey."
                : focusedMcp
                  ? mcpConnections?.find(({ id }) => id === focusedMcp.id)?.status === "connected"
                    ? `${focusedMcp.name} is connected. You can return to the terminal.`
                    : mcpConnectionAction === focusedMcp.id
                      ? `Continue in ${focusedMcp.name}. You’ll return here when it is connected.`
                      : "Continue with your passkey."
                : "Review this CLI installation’s hosted access."}</p>
        </div>
        {confirmationCode ? (
          <div className="wizard-terminal-code" role="status">
            <span>Confirm this matches your terminal</span>
            <strong>{confirmationCode.slice(0, 4)}-{confirmationCode.slice(4)}</strong>
          </div>
        ) : null}
      </header>

      <div className="wizard-sections">
        {request.permission.connectors.length ? <section className="wizard-section" aria-labelledby="wizard-services-heading">
          <header className="wizard-section-title">
            <div><span>Service</span><h2 id="wizard-services-heading">{focused ? focused.name : "Connections"}</h2></div>
            <small>{focused ? "Requested by CLI" : `${request.permission.connectors.length} requested by CLI`}</small>
          </header>
          <WizardConnectorList connectorAction={connectorAction} connectorStatuses={connectorStatuses} disabled={disabled} onConnectConnector={onConnectConnector} request={request} />
          {deviceCode ? (
            <a className="wizard-device-code" href={deviceCode.url} rel="noreferrer" target="_blank">
              <span>Continue in ChatGPT with code</span>
              <strong>{deviceCode.code}</strong>
            </a>
          ) : null}
        </section> : null}

        {request.mcpConnections.length ? <section className="wizard-section" aria-labelledby="wizard-mcp-heading">
          <header className="wizard-section-title">
            <div><span>MCP</span><h2 id="wizard-mcp-heading">{focusedMcp ? focusedMcp.name : "MCP connections"}</h2></div>
            <small>{focusedMcp ? "Requested by CLI" : `${request.mcpConnections.length} requested by CLI`}</small>
          </header>
          <McpConnectionList
            action={mcpConnectionAction}
            connections={mcpConnections ?? request.mcpConnections}
            disabled={disabled}
            focusedId={request.focusMcpConnection}
            onConnect={onConnectMcp}
          />
        </section> : null}

        {!focused && !focusedMcp ? <section className="wizard-section" aria-labelledby="wizard-access-heading">
          <header className="wizard-section-title">
            <div><span>Access</span><h2 id="wizard-access-heading">CLI access</h2></div>
            <small>{request.accessKey ? "30-day key" : "Active key"}</small>
          </header>
          <WizardRequestSummary appVisibility={appVisibility} request={request} />
        </section> : null}
      </div>
      {completed ? (
        <div className="completion-actions">
          <a href="/connect">Connect more accounts</a>
        </div>
      ) : null}
    </div>
  );
}

function WizardConnectorList({ connectorAction, connectorStatuses, disabled, onConnectConnector, request }: Readonly<{
  connectorAction?: ConnectorId | undefined;
  connectorStatuses?: ConnectorStatuses | undefined;
  disabled: boolean;
  onConnectConnector(id: ConnectorId): void;
  request: ConnectionView;
}>) {
  const connectors = request.focusConnector
    ? request.permission.connectors.filter((connector) => connector.id === request.focusConnector)
    : request.permission.connectors;
  return (
    <div className="wizard-connectors" role="list">
      {connectors.map((connector) => {
        const id = connector.id as ConnectorId;
        const status = connectorStatuses?.[id];
        const resolved = connectorStatuses !== undefined;
        const actionDisabled = disabled || connectorAction !== undefined || !resolved || status?.connected;
        return (
          <div className="wizard-connector-card" key={id} role="listitem">
            <button
              className={`connection-card${status?.connected ? " is-connected" : ""}`}
              disabled={actionDisabled}
              onClick={() => onConnectConnector(id)}
              type="button"
            >
              <ConnectorLogo id={id} name={connector.name} />
              <span className="connection-card-copy">
                <strong>{permissionTitle(id, connector.name)}</strong>
                <span>{status?.connected
                  ? status.label ? `Connected as ${status.label}` : "Connected"
                  : connector.detail}</span>
              </span>
              <span className="connection-card-action">
                {!resolved
                  ? "Required"
                  : status?.connected
                    ? "Connected"
                    : connectorAction === id ? "Connecting…" : "Connect"}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function McpConnectionList({ action, connections, disabled, focusedId, onConnect }: Readonly<{
  action?: string | undefined;
  connections: readonly McpConnection[];
  disabled: boolean;
  focusedId?: string | undefined;
  onConnect(id: string): void;
}>) {
  const visible = focusedId
    ? connections.filter(({ id }) => id === focusedId)
    : connections;
  return (
    <div className="mcp-connections" role="list" aria-label="MCP connections">
      {visible.map((connection) => {
        const connected = connection.status === "connected";
        const canConnect = mcpConnectionCanAuthorize(connection.status);
        return (
          <div className={`mcp-connection-card${connected ? " is-connected" : ""}`} key={connection.id} role="listitem">
            <span className="mcp-connection-logo" aria-hidden="true">M</span>
            <span className="mcp-connection-copy">
              <strong>{connection.name}</strong>
              <small>{mcpConnectionStatusLabel(connection.status)}</small>
            </span>
            {canConnect ? (
              <button
                disabled={disabled || action !== undefined}
                onClick={() => onConnect(connection.id)}
                type="button"
              >
                {action === connection.id
                  ? "Connecting…"
                  : connection.status === "reauthorization_required" ? "Reconnect" : "Connect"}
              </button>
            ) : (
              <span className="mcp-connection-state">{connected ? "Connected" : mcpConnectionStatusLabel(connection.status)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function WizardRequestSummary({ appVisibility, request }: Readonly<{
  appVisibility: ReturnType<typeof appVisibilityPermissions>;
  request: ConnectionView;
}>) {
  return (
    <section className="wizard-request-summary" aria-labelledby="wizard-request-heading">
      <h2 className="sr-only" id="wizard-request-heading">Installation capabilities</h2>
      <div className="wizard-visibility" role="list" aria-label="App sees">
        {appVisibility.map((permission) => (
          <div key={permission.resource} role="listitem">
            <span>✓</span>
            <div><strong>{permission.label}</strong><small>{permission.detail}</small></div>
          </div>
        ))}
      </div>
      <details className="advanced-details">
        <summary>Technical details</summary>
        <dl className="key-details">
          <Detail label="App" value={request.app.origin} />
          {request.accessKey ? (
            <>
              <Detail label="Key" value={request.accessKey.keyId} />
              <Detail label="Expires" value={formatExpiry(request.accessKey.expiry)} />
            </>
          ) : <Detail label="Key" value="Reuse the app's active delegated signer" />}
        </dl>
        <ul className="resource-list" aria-label="Connect capability resources">
          {request.auth.resources.map((resource) => <li key={resource}>{resource}</li>)}
        </ul>
      </details>
    </section>
  );
}

type FundingAttempt = Readonly<{
  clientSecret: string;
  id: string;
  orderToken: string;
  stripe: Stripe;
}>;

function FundingApproval({ host, request, onReject }: Readonly<{
  host: ConnectOnboardingHost;
  request: Dialog.FundingRequest;
  onReject(): void;
}>) {
  const dollars = (request.usdAmountCents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const paymentTarget = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState<FundingAttempt>();
  const [elements, setElements] = useState<StripeElements>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !request.accountAddress) return;
    started.current = true;
    void preparePayment();
  }, [request.id]);

  useEffect(() => {
    if (!attempt || !paymentTarget.current) return;
    const next = attempt.stripe.elements({
      clientSecret: attempt.clientSecret,
      appearance: {
        theme: "night",
        variables: {
          borderRadius: "0px",
          colorBackground: "#161616",
          colorDanger: "#ff8585",
          colorPrimary: "#ffffff",
          colorText: "#ffffff",
          colorTextSecondary: "rgba(255,255,255,.62)",
          fontFamily: "Berkeley Mono, ui-monospace, monospace",
          spacingUnit: "3px",
        },
      },
    });
    const payment = next.create("payment", { layout: "tabs" });
    payment.mount(paymentTarget.current);
    setElements(next);
    return () => {
      payment.destroy();
      setElements(undefined);
    };
  }, [attempt]);

  async function preparePayment() {
    if (!request.accountAddress || busy) return;
    setFailure(undefined);
    setBusy(true);
    try {
      const orderToken = randomToken();
      const response = await fetch(onrampUrl(request.apiUrl, "/v1/machine-usd/orders"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": request.id,
        },
        body: JSON.stringify({
          wallet_address: request.accountAddress,
          usd_amount_cents: request.usdAmountCents,
          order_token: orderToken,
        }),
      });
      const body = await response.json() as Record<string, any>;
      if (!response.ok) throw new Error(apiError(body, "Unable to create the machineUSD order."));
      const stripe = await loadStripe(request.stripePublishableKey);
      if (!stripe) throw new Error("Stripe could not initialize the embedded payment form.");
      if (typeof body.order?.id !== "string" || typeof body.payment?.client_secret !== "string") {
        throw new Error("The machineUSD order response is invalid.");
      }
      setAttempt({
        clientSecret: body.payment.client_secret,
        id: body.order.id,
        orderToken,
        stripe,
      });
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPayment() {
    if (!attempt || !elements || busy) return;
    setFailure(undefined);
    setBusy(true);
    try {
      const submitted = await elements.submit();
      if (submitted.error) throw new Error(submitted.error.message);
      const confirmed = await attempt.stripe.confirmPayment({
        elements,
        clientSecret: attempt.clientSecret,
        confirmParams: { return_url: window.location.href },
        redirect: "if_required",
      });
      if (confirmed.error) throw new Error(confirmed.error.message);
      const order = await waitForOrder(request.apiUrl, attempt);
      await host.respond({
        order: {
          id: order.id,
          status: order.status,
          usd_amount_cents: order.usd_amount_cents,
          machine_usd_amount_atomics: String(order.usd_amount_cents * 10_000),
          issuance_transaction_hash: order.issuance_transaction_hash,
        },
      });
    } catch (error) {
      setFailure(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="dialog-content">
        <section className="request-title" aria-labelledby="approval-heading">
          <h1 id="approval-heading">Add MACHUSD</h1>
        </section>

        <section className="onramp-card" aria-label="machineUSD card onramp">
          <div className="card-topline">
            <span>machineUSD</span>
            <span className="card-method">CARD</span>
          </div>
          <div className="funding-amount"><span>$</span>{dollars}</div>
          {attempt ? <div className="stripe-payment-element" ref={paymentTarget} /> : (
            <dl className="funding-details">
              <Detail label="Grant" value={request.grantId} />
              <Detail label="Token" value={request.tokenAddress} />
              <Detail label="Network" value={`Tempo · ${request.chainId}`} />
              {request.accountAddress ? <Detail label="Account" value={request.accountAddress} /> : null}
            </dl>
          )}
        </section>

        {failure ? <p className="dialog-error" role="alert">{failure}</p> : null}
      </div>
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onReject}>Cancel</button>
        <button
          type="button"
          disabled={busy || (attempt ? !elements : !request.accountAddress)}
          onClick={attempt ? confirmPayment : preparePayment}
        >
          {attempt ? `Pay $${dollars}` : failure ? "Try again" : "Secure card form"}
        </button>
      </div>
    </>
  );
}

async function waitForOrder(apiUrl: string, attempt: FundingAttempt) {
  for (;;) {
    const response = await fetch(onrampUrl(apiUrl, `/v1/machine-usd/orders/${encodeURIComponent(attempt.id)}`), {
      headers: { authorization: `Bearer ${attempt.orderToken}` },
    });
    const body = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(apiError(body, "Unable to read the machineUSD order."));
    const order = body.order;
    const status = classifyMachineUsdOrder(order);
    if (status === "complete") return order;
    if (status === "failed") {
      throw new Error("The machineUSD purchase did not complete.");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
  }
}

function onrampUrl(apiUrl: string, path: string) {
  return `${apiUrl.replace(/\/+$/, "")}${path}`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function apiError(body: Record<string, any>, fallback: string) {
  return typeof body.error?.message === "string" ? body.error.message : fallback;
}

function SectionHeading({ id, label, value }: Readonly<{ id: string; label: string; value: string }>) {
  return (
    <div className="section-heading">
      <h2 id={id}>{label}</h2>
      <span>{value}</span>
    </div>
  );
}

function AppMark({ name }: Readonly<{ name: string }>) {
  return <span className="app-mark" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

function ConnectorLogo({ id, name }: Readonly<{ id: string; name: string }>) {
  if (id === "chatgpt" || id === "model") {
    return (
      <span className="connector-logo connector-logo-openai" aria-hidden="true">
        <svg viewBox="146 227 268 265" role="presentation">
          <path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z" />
        </svg>
      </span>
    );
  }
  if (id === "github") {
    return (
      <span className="connector-logo connector-logo-github" aria-hidden="true">
        <svg viewBox="0 0 24 24" role="presentation">
          <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.41-1.27.74-1.56-2.57-.29-5.27-1.29-5.27-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.11c.98 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.27c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
        </svg>
      </span>
    );
  }
  if (id === "gmail") {
    return (
      <span className="connector-logo connector-logo-gmail" aria-hidden="true">
        <svg viewBox="0 0 24 18" role="presentation">
          <path fill="#4285f4" d="M1.7 18H5V6.4L0 2.65v13.7C0 17.26.74 18 1.7 18Z" />
          <path fill="#34a853" d="M19 18h3.3c.96 0 1.7-.74 1.7-1.65V2.65L19 6.4V18Z" />
          <path fill="#fbbc04" d="M19 6.4 24 2.65V1.8C24-.23 21.68-.9 20.23.18L19 1.1v5.3Z" />
          <path fill="#ea4335" d="M5 6.4V1.1L12 6.35l7-5.25v5.3l-7 5.25L5 6.4Z" />
          <path fill="#c5221f" d="M0 1.8v.85L5 6.4V1.1L3.77.18C2.32-.9 0-.23 0 1.8Z" />
        </svg>
      </span>
    );
  }
  if (id === "gdrive") {
    return (
      <span className="connector-logo connector-logo-drive" aria-hidden="true">
        <svg viewBox="0 0 24 22" role="presentation">
          <path fill="#0f9d58" d="M8.2 14.7 4.1 22h11.7l4.1-7.3H8.2Z" />
          <path fill="#ffcd40" d="m16 0 8 14.7h-8L8 0h8Z" />
          <path fill="#4285f4" d="M8 0 0 14.7 4.1 22 12 7.3 8 0Z" />
        </svg>
      </span>
    );
  }
  if (id === "x") {
    return <span className="connector-logo connector-logo-x" aria-hidden="true">X</span>;
  }
  return (
    <span className="connector-logo connector-logo-nanocodex" aria-hidden="true" title={name}>
      <svg viewBox="0 0 24 24" role="presentation">
        <path d="M10.4 3h3.2v7.4H21v3.2h-7.4V21h-3.2v-7.4H3v-3.2h7.4V3Z" />
      </svg>
    </span>
  );
}

function SpendLogo() {
  return (
    <span className="connector-logo connector-logo-spend" aria-hidden="true">
      <span>M</span>
      <i>≤</i>
    </span>
  );
}

function permissionTitle(id: string, fallback: string) {
  if (id === "github") return "GitHub";
  if (id === "gmail") return "Gmail";
  if (id === "gdrive") return "Google Drive";
  if (id === "x") return "X";
  if (id === "chatgpt" || id === "model") return "ChatGPT";
  return fallback;
}

function connectorStateLabel(status: ConnectorStatus | undefined, resolved: boolean) {
  if (!resolved) return "Requested";
  if (!status?.connected) return "Not connected";
  return status.label ? `Connected as ${status.label}` : "Connected";
}

function connectorTooltip(status: ConnectorStatus | undefined, detail: string, resolved: boolean) {
  return `${connectorStateLabel(status, resolved)} · ${detail}`;
}

function Detail({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function PermissionRow({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="permission-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatExpiry(expiry: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(expiry * 1_000)) + " UTC";
}

function expiryLabel(expiry: number) {
  const days = Math.max(1, Math.round((expiry * 1_000 - Date.now()) / 86_400_000));
  return `${days} day expiry`;
}

function formatToken(atomics: bigint, symbol: string) {
  const whole = atomics / 1_000_000n;
  const fractional = (atomics % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const amount = fractional ? `${whole}.${fractional}` : whole.toString();
  return `${amount} ${symbol}`;
}

function formatPeriod(seconds: number) {
  if (seconds === 86_400) return "24 hours";
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  return `${seconds} seconds`;
}

function shortAddress(value: unknown) {
  return typeof value === "string" && value.length > 15
    ? `${value.slice(0, 8)}…${value.slice(-6)}`
    : "Unavailable";
}

function walletRequest(
  request: WalletRequest,
  accountMode: "login" | "register",
  registrationUserId?: string,
  selectedCredentialId?: string,
  selectedLabel?: string,
  discoverCredential?: boolean,
  hostedRegistration = false,
) {
  const params = record(firstParam(request.rpc.params));
  const capabilities = record(params.capabilities);
  const { resources } = walletConnectContext(request);
  const {
    auth: _auth,
    credentialId: _credentialId,
    method: _method,
    name: _name,
    selectAccount: _selectAccount,
    userId: _userId,
    authorizeAccessKey,
    ...sharedCapabilities
  } = capabilities;
  const apiUrl = connectApiUrl(request);
  const walletAuth = (() => {
    const auth = capabilities.auth;
    if (!auth) return auth;
    if (typeof auth === "string") {
      return { url: auth, verify: `${apiUrl}/v1/connect/auth` };
    }
    const forwarded = record(auth);
    return {
      ...forwarded,
      verify: `${apiUrl}/v1/connect/auth`,
      resources,
    };
  })();
  return {
    ...request.rpc,
    params: [{
      ...params,
      capabilities: {
        ...sharedCapabilities,
        ...(accountMode === "login"
          ? selectedCredentialId
            ? { method: "login", credentialId: selectedCredentialId }
            : discoverCredential
              ? { method: "login", selectAccount: true }
              : accountLoginCapabilities(storedProviderAccounts())
          : {
              method: "register",
              name: selectedLabel || (registrationUserId
                ? `Nanocodex ${registrationUserId}`
                : "Nanocodex Connect"),
              ...(registrationUserId ? { userId: registrationUserId } : {}),
            }),
        ...(!hostedRegistration && walletAuth ? { auth: walletAuth } : {}),
        ...(!hostedRegistration && authorizeAccessKey ? { authorizeAccessKey } : {}),
      },
    }],
  };
}

function storedProviderAccounts(): unknown {
  return providerStore.getState().accounts;
}

async function clearPortableCredential(apiUrl: string): Promise<void> {
  const response = await fetch(`${apiUrl}/webauthn/portable-credential`, {
    credentials: "include",
    method: "DELETE",
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error("Could not reset the saved passkey. Reload and try again.");
  }
}

function createProvider(browserLocal: boolean) {
  return Provider.create({
    adapter: webAuthn(browserLocal
      ? {
          name: "Nanocodex",
          rdns: "xyz.paradigm.nanocodex",
        }
      : {
          auth: "/webauthn",
          name: "Nanocodex",
          rdns: "xyz.paradigm.nanocodex",
        }),
    maxAccounts: 1,
    mpp: false,
    storage: Storage.idb({ key: "nanocodex" }),
  });
}

async function ensureBrowserSession() {
  if (browserSession) return browserSession;
  const attempt = (async () => {
    const response = await fetch("/v1/me", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(apiError(record(body), "Unable to start a Nanocodex browser session."));
    }
    if (
      !isRecord(body)
      || !isRecord(body.user)
      || typeof body.user.id !== "string"
      || typeof body.user.persistent !== "boolean"
    ) {
      throw new Error("The Nanocodex account service returned an invalid browser session.");
    }
    return { id: body.user.id, persistent: body.user.persistent };
  })();
  browserSession = attempt;
  try {
    return await attempt;
  } catch (error) {
    if (browserSession === attempt) browserSession = undefined;
    throw error;
  }
}

function invalidateBrowserSession() {
  browserSession = undefined;
}

async function prepareRegistrationSession() {
  let session = await ensureBrowserSession();
  if (!session.persistent) return session.id;
  await provider.request({ method: "wallet_disconnect" });
  invalidateBrowserSession();
  session = await ensureBrowserSession();
  if (session.persistent) {
    throw new Error("Nanocodex could not start a new browser account. Sign out and try again.");
  }
  return session.id;
}

function walletView(request: WalletRequest): ConnectionView {
  const params = record(firstParam(request.rpc.params));
  const capabilities = record(params.capabilities);
  const { app, resources } = walletConnectContext(request);
  const requestedConnectors = requestedConnectorIdsFromResources(resources);
  const focusConnector = focusedConnectorFromResources(resources, requestedConnectors);
  const mcpRequest = requestedMcpConnectionsFromRequest(request, resources);
  const access = record(capabilities.authorizeAccessKey);
  const limits = array(access.limits).map((value) => {
    const limit = record(value);
    return {
      token: hex(limit.token),
      limit: BigInt(String(limit.limit)),
      ...(typeof limit.period === "number" ? { period: limit.period } : {}),
    };
  });
  const scopes = array(access.scopes).map((value) => {
    const scope = record(value);
    return {
      address: hex(scope.address),
      ...(typeof scope.selector === "string" ? { selector: scope.selector } : {}),
      ...(Array.isArray(scope.recipients) ? { recipients: scope.recipients.map(hex) } : {}),
    };
  });
  const primary = limits[0] ?? {
    token: "0x20c0000000000000000000006637932dE5413804" as const,
    limit: 10_000_000n,
    period: 86_400,
  };
  const preparedAccessKey = typeof access.address === "string" && typeof access.publicKey === "string"
    ? {
        address: hex(access.address),
        chainId: BigInt(String(access.chainId ?? params.chainId ?? "0x1079")),
        keyId: hex(access.address),
        publicKey: hex(access.publicKey),
        keyType: access.keyType === "webAuthn" || access.keyType === "secp256k1" ? access.keyType : "p256" as const,
        limits,
        scopes,
        expiry: Number(access.expiry),
      }
    : undefined;
  return {
    id: request.id,
    type: "connect",
    app,
    accountAddress: "0x0000000000000000000000000000000000000000",
    auth: {
      resources,
    },
    permission: {
      id: "agent.run",
      title: "Use your Nanocodex agent",
      description: "Run an app-owned Nanocodex agent with your approved capabilities.",
      connectors: requestedConnectors.map(connectorDefinition),
    },
    mcpConnections: mcpRequest.connections,
    ...(focusConnector ? { focusConnector } : {}),
    ...(mcpRequest.focus ? { focusMcpConnection: mcpRequest.focus } : {}),
    ...(preparedAccessKey ? { accessKey: preparedAccessKey } : {}),
    ...(resources.includes("urn:nanocodex:mpp:machusd:spend") ? {
      mpp: {
        token: primary.token,
        symbol: "MACHUSD",
        limit: primary.limit,
        period: primary.period ?? 86_400,
        maxPerRequest: 250_000n,
      },
    } : {}),
  };
}

function requestedConnectorIdsFromResources(resources: readonly string[]): ConnectorId[] {
  return [...new Set(resources.flatMap((resource) => {
    if (resource.startsWith(connectorResourcePrefix)) {
      return [resource.slice(connectorResourcePrefix.length)];
    }
    if (resource.startsWith(connectorsResourcePrefix)) {
      return resource.slice(connectorsResourcePrefix.length).split(",");
    }
    return [];
  }).filter(isConnectorId))];
}

function requestedMcpConnectionIdsFromResources(resources: readonly string[]): string[] {
  const ids = resources.flatMap((resource) => resource.startsWith(mcpConnectionResourcePrefix)
    ? [resource.slice(mcpConnectionResourcePrefix.length)]
    : []);
  if (ids.some((id) => !/^[A-Za-z0-9_-]{43}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("The requested MCP connection resources are invalid.");
  }
  return ids;
}

function requestedMcpConnectionsFromRequest(
  request: WalletRequest,
  resources: readonly string[],
): Readonly<{ connections: readonly McpConnection[]; focus?: string | undefined }> {
  const ids = requestedMcpConnectionIdsFromResources(resources);
  const connections = request.requestedMcpConnections === undefined
    ? mcpConnectionsFromWire(ids.map((id) => ({
        id,
        name: "MCP connection",
        status: "authorization_required",
      })))
    : mcpConnectionsFromWire(request.requestedMcpConnections);
  if (connections.length !== ids.length
    || connections.some(({ id }) => !ids.includes(id))) {
    throw new Error("The requested MCP connections do not match the signed resources.");
  }
  const signedFocus = resources.flatMap((resource) => resource.startsWith(mcpFocusResourcePrefix)
    ? [resource.slice(mcpFocusResourcePrefix.length)]
    : []);
  if (signedFocus.some((id) => !/^[A-Za-z0-9_-]{43}$/.test(id)) || signedFocus.length > 1) {
    throw new Error("The focused MCP connection is invalid.");
  }
  const focus = focusedMcpConnection(request.focusMcpConnection ?? signedFocus[0], connections);
  if (request.focusMcpConnection !== undefined && signedFocus[0] !== request.focusMcpConnection) {
    throw new Error("The focused MCP connection does not match the signed resources.");
  }
  if (request.returnedMcpConnection !== undefined
    && (!/^[A-Za-z0-9_-]{43}$/.test(request.returnedMcpConnection)
      || !ids.includes(request.returnedMcpConnection))) {
    throw new Error("The returned MCP connection is invalid.");
  }
  if (focus && focusedConnectorFromResources(resources, requestedConnectorIdsFromResources(resources))) {
    throw new Error("Nanocodex Connect received more than one focused connection.");
  }
  return { connections, ...(focus ? { focus } : {}) };
}

function connectorDefinition(id: ConnectorId) {
  if (id === "github") return { id, name: "GitHub", detail: "Repositories and workflows" };
  if (id === "gmail") return { id, name: "Gmail", detail: "Read and send email" };
  if (id === "gdrive") return { id, name: "Google Drive", detail: "Read and create files" };
  if (id === "x") return { id, name: "X", detail: "Posts, follows, likes, lists, and messages" };
  return { id, name: "ChatGPT", detail: "Model access through your account" };
}

function isConnectorId(value: string): value is ConnectorId {
  return (connectorIds as readonly string[]).includes(value);
}

function connectApiUrl(request: WalletRequest) {
  const params = record(firstParam(request.rpc.params));
  return connectApiOrigin(record(params.capabilities).auth, window.location.origin);
}

function nanocodexOriginFor(apiUrl: string) {
  const origin = new URL(apiUrl).origin;
  return isLocalDevelopmentOrigin(origin) ? origin : productionNanocodexOrigin;
}

function walletConnectContext(request: WalletRequest) {
  const params = record(firstParam(request.rpc.params));
  const auth = record(record(params.capabilities).auth);
  const resources = Array.isArray(auth.resources)
    ? auth.resources.filter((value): value is string => typeof value === "string")
    : [];
  const app = registeredApp(
    request.origin,
    request.appId,
    window.location.href,
    window.parent === window,
  );
  signedAppResources(resources, app);
  focusedConnectorFromResources(resources, requestedConnectorIdsFromResources(resources));
  requestedMcpConnectionsFromRequest(request, resources);
  return { app, resources };
}

function isConnectorCompletion(value: unknown): value is Readonly<{
  type: "nanocodex:connector-complete";
  connector: ConnectorId;
  result: "success" | "error";
  error?: string | undefined;
  message?: string | undefined;
}> {
  return isRecord(value)
    && value.type === "nanocodex:connector-complete"
    && typeof value.connector === "string"
    && isConnectorId(value.connector)
    && (value.result === "success" || value.result === "error")
    && (value.error === undefined || typeof value.error === "string")
    && (value.message === undefined || typeof value.message === "string");
}

function walletRequestPolicyError(request: ConnectRequest | undefined) {
  if (!request
    || request.type === "machineUsdFund"
    || request.type === "deviceError"
    || request.type === "deviceComplete") return undefined;
  try {
    if (request.type === "walletConnect") {
      walletConnectContext(request);
      connectApiUrl(request);
    } else {
      registeredApp(request.origin, request.appId, window.location.href, window.parent === window, false);
    }
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function allowsAutomaticSavedAccount(request: WalletRequest): boolean {
  if (request.confirmationCode === undefined) return false;
  try {
    const resources = walletConnectContext(request).resources;
    return resources.includes(hostedAuthorizationResource)
      && !resources.includes("urn:nanocodex:mpp:machusd:spend");
  } catch {
    return false;
  }
}

function isActiveConnector(
  current: ConnectorAttempt | undefined,
  expected: ConnectorAttempt,
  requestId: string | undefined,
) {
  return current === expected
    && current.token === expected.token
    && requestId === expected.requestId
    && !expected.abort.signal.aborted;
}

function requestedConnectorsReady(
  approval: PendingApproval,
  statuses: ConnectorStatuses,
): boolean {
  return approval.requestedConnectors.every((connector) => statuses[connector]?.connected === true);
}

function requestedMcpConnections(
  requested: readonly McpConnection[],
  wire: unknown,
): readonly McpConnection[] {
  if (requested.length === 0) return [];
  const available = mcpConnectionsFromWire(wire);
  const requestedIds = new Set(requested.map(({ id }) => id));
  const selected = available.filter(({ id }) => requestedIds.has(id));
  if (selected.length !== requestedIds.size) {
    throw new Error("The account broker did not return every requested MCP connection.");
  }
  return selected;
}

function approvalReady(
  approval: PendingApproval,
  connectors: ConnectorStatuses,
  mcpConnections: readonly McpConnection[],
): boolean {
  return connectorApprovalDisposition(approval.requestedConnectors, connectors) === "respond"
    && mcpConnectionApprovalDisposition(approval.requestedMcpConnections, mcpConnections) === "respond";
}

function mcpConnectionFromStartResponse(body: Record<string, unknown>, expectedId: string): McpConnection {
  const candidate = body.mcp_connection ?? body.connection;
  const parsed = mcpConnectionsFromWire([candidate]);
  if (parsed[0]?.id !== expectedId) {
    throw new Error("The account broker returned the wrong MCP connection.");
  }
  return parsed[0];
}

function replaceMcpConnection(
  connections: readonly McpConnection[],
  replacement: McpConnection,
): readonly McpConnection[] {
  return connections.map((connection) => connection.id === replacement.id ? replacement : connection);
}

function mcpConnectionCanAuthorize(status: McpConnection["status"]): boolean {
  return status === "authorization_required"
    || status === "reauthorization_required";
}

function deviceReturnPath(): string {
  return deviceMcpReturnPath(window.location.href);
}

function mcpConnectionStatusLabel(status: McpConnection["status"]): string {
  if (status === "connected") return "Connected";
  if (status === "authorization_required") return "Authorization required";
  if (status === "reauthorization_required") return "Reconnect required";
  if (status === "disabled") return "Disabled";
  return "Revoked";
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("The connector request was canceled.", "AbortError"));
      return;
    }
    const timeout = window.setTimeout(done, milliseconds);
    signal.addEventListener("abort", canceled, { once: true });
    function done() {
      signal.removeEventListener("abort", canceled);
      resolve();
    }
    function canceled() {
      window.clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("The connector request was canceled.", "AbortError"));
    }
  });
}

function requiredExpiry(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("The account broker returned no ChatGPT device-code expiry.");
  }
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  if (milliseconds <= Date.now()) throw new Error("The ChatGPT device code has already expired.");
  return milliseconds;
}

function pollDelay(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 500 && value <= 30_000
    ? value
    : 2_000;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function requiredUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("The account broker returned no authorization URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLocalDevelopmentOrigin(url.origin)) {
    throw new Error("The account broker returned an unsafe authorization URL.");
  }
  return url.href;
}

function mcpCallbackContinuationKey(requestId: string) {
  return `${mcpCallbackContinuationPrefix}${requestId}`;
}

function clearMcpCallbackContinuation(requestId: string) {
  window.sessionStorage.removeItem(mcpCallbackContinuationKey(requestId));
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing.`);
  return value;
}

function opaqueToken(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`The account broker returned an invalid ${label}.`);
  }
  return value;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstParam(value: unknown) {
  return Array.isArray(value) ? value[0] : undefined;
}

function hex(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("Nanocodex Connect received invalid access-key material.");
  }
  return value as `0x${string}`;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.includes("Server Authentication verify endpoint") && message.includes("401")) {
    return "That passkey is not linked to this Nanocodex account. Choose another passkey or create a new account.";
  }
  if (/unknown credential/i.test(message)) {
    return "This localhost instance does not know that passkey. Choose the saved passkey or create a new account.";
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "No matching passkey was available, or the request was cancelled. Choose another passkey or create a new account.";
  }
  if (message) return message;
  return "The passkey ceremony failed. Try again or reject the request.";
}
