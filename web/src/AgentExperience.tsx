import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentStatus,
  AgentTerminalMode,
  AgentTerminalState,
} from "./agentTerminalTypes";
import { AgentTerminal } from "./AgentTerminal";
import { browserAgentCapabilityError } from "./browserAgentCapabilities";
import {
  AgentSessionBar,
  inactiveTerminalMessage,
  type ChatGptStatus,
  type CredentialSource,
} from "./chatGptSession";
import "./AgentTerminal.css";
import "./Home.css";

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
  const [runtimeState, setRuntimeState] = useState<AgentTerminalState>();
  const hasCredential = isAuthenticatedCredential(credentialSource);

  const changeCredentialSource = useCallback((source: CredentialSource) => {
    if (isAuthenticatedCredential(credentialSourceRef.current) && !isAuthenticatedCredential(source)) {
      setRuntimeState(undefined);
    }
    credentialSourceRef.current = source;
    setCredentialSource(source);
  }, []);

  const agentStatus: AgentStatus = !hasCredential || capabilityError
    ? "idle"
    : runtimeState?.status ?? "starting";
  const agentError = runtimeState?.error;
  const retryAgent = useCallback(() => {
    runtimeState?.retry();
  }, [runtimeState]);
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
      {hasCredential && !capabilityError ? (
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
  return source === "brokered" || source === "subscription" || source === "user";
}
