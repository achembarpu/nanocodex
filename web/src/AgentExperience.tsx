import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import type {
  AgentStatus,
  AgentTerminalMode,
  AgentTerminalState,
} from "./agentTerminalTypes";
import { browserAgentCapabilityError } from "./browserAgentCapabilities";
import {
  AgentSessionBar,
  inactiveTerminalMessage,
  type ChatGptStatus,
  type CredentialSource,
} from "./chatGptSession";
import "./AgentTerminal.css";

type AuthenticatedAgentTerminal = ComponentType<{
  authStatus: ChatGptStatus | undefined;
  mode: AgentTerminalMode;
  onStateChange(state: AgentTerminalState): void;
  source: Exclude<CredentialSource, null>;
  theme: "light" | "dark";
}>;

let agentTerminalRequest: Promise<AuthenticatedAgentTerminal> | undefined;

function loadAgentTerminal(): Promise<AuthenticatedAgentTerminal> {
  if (agentTerminalRequest) return agentTerminalRequest;
  const request = import("./AgentTerminal").then((module) => module.AgentTerminal);
  agentTerminalRequest = request;
  void request.catch(() => {
    if (agentTerminalRequest === request) agentTerminalRequest = undefined;
  });
  return request;
}

/** Warms the authenticated terminal boundary without creating an Agent or UI. */
export function preloadAgentTerminal(): Promise<void> {
  return loadAgentTerminal().then(() => undefined);
}

/** Lightweight credential shell that keeps the authenticated runtime off signed-out startup. */
export const AgentExperience = memo(function AgentExperience({
  mode,
  theme,
}: {
  mode: AgentTerminalMode;
  theme: "light" | "dark";
}) {
  const capabilityError = useMemo(() => browserAgentCapabilityError(), []);
  const [authStatus, setAuthStatus] = useState<ChatGptStatus>();
  const [credentialSource, setCredentialSource] = useState<CredentialSource>();
  const credentialSourceRef = useRef<CredentialSource | undefined>(undefined);
  const [AgentTerminal, setAgentTerminal] = useState<AuthenticatedAgentTerminal>();
  const [agentTerminalError, setAgentTerminalError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [runtimeState, setRuntimeState] = useState<AgentTerminalState>();
  const hasCredential = isAuthenticatedCredential(credentialSource);

  const changeCredentialSource = useCallback((source: CredentialSource) => {
    if (isAuthenticatedCredential(credentialSourceRef.current) && !isAuthenticatedCredential(source)) {
      setRuntimeState(undefined);
    }
    credentialSourceRef.current = source;
    setCredentialSource(source);
  }, []);

  useEffect(() => {
    if (!hasCredential || capabilityError) {
      setAgentTerminal(undefined);
      setAgentTerminalError(undefined);
      return;
    }
    let current = true;
    setAgentTerminalError(undefined);
    void loadAgentTerminal().then(
      (terminal) => {
        if (current) setAgentTerminal(() => terminal);
      },
      (cause) => {
        if (current) setAgentTerminalError(errorMessage(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [capabilityError, hasCredential, loadAttempt]);

  const agentStatus: AgentStatus = !hasCredential || capabilityError
    ? "idle"
    : agentTerminalError !== undefined
      ? "error"
      : runtimeState?.status ?? "starting";
  const agentError = agentTerminalError ?? runtimeState?.error;
  const retryAgent = useCallback(() => {
    if (agentTerminalError !== undefined) {
      setAgentTerminalError(undefined);
      setLoadAttempt((attempt) => attempt + 1);
      return;
    }
    runtimeState?.retry();
  }, [agentTerminalError, runtimeState]);
  const inactiveMessage = inactiveTerminalMessage({
    agentError,
    agentStatus,
    authStatus,
    capabilityError,
    source: credentialSource,
  });

  return (
    <div className={`nanocodex-demo is-${mode}`}>
      <AgentSessionBar
        agentStatus={agentStatus}
        agentError={agentError}
        source={credentialSource}
        capabilityError={capabilityError}
        onAuthStatusChange={setAuthStatus}
        onRetryAgent={retryAgent}
        onSourceChange={changeCredentialSource}
      />
      {hasCredential && !capabilityError && AgentTerminal ? (
        <AgentTerminal
          authStatus={authStatus}
          mode={mode}
          onStateChange={setRuntimeState}
          source={credentialSource}
          theme={theme}
        />
      ) : (
        <ReservedTerminal message={inactiveMessage} mode={mode} />
      )}
    </div>
  );
});

function ReservedTerminal({
  message,
  mode,
}: {
  message: string;
  mode: AgentTerminalMode;
}) {
  const terminal = (
    <div className="agent-terminal-shell">
      <p className="agent-terminal-standby" aria-hidden="true">{message}</p>
    </div>
  );
  return mode === "full" ? (
    <div className="agent-terminal-workspace">{terminal}</div>
  ) : terminal;
}

function isAuthenticatedCredential(
  source: CredentialSource | undefined,
): source is Exclude<CredentialSource, null> {
  return source === "subscription" || source === "user";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
