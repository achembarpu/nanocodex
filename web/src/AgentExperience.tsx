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
import { AgentTerminal, ManagedAgentTerminal } from "./AgentTerminal";
import { browserAgentCapabilityError } from "./browserAgentCapabilities";
import {
  AgentSessionBar,
  inactiveTerminalMessage,
  type ModelSessionStatus,
  type CredentialSource,
} from "./modelSession";
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
  const [runtime, setRuntime] = useState<"local" | "managed">(() =>
    localStorage.getItem("nanocodex.agent-runtime.v1") === "managed" ? "managed" : "local"
  );
  const [authStatus, setAuthStatus] = useState<ModelSessionStatus>();
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

  const activeCapabilityError = runtime === "local" ? capabilityError : undefined;
  const agentStatus: AgentStatus = !hasCredential || activeCapabilityError
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
    capabilityError: activeCapabilityError,
    source: credentialSource,
  });

  return (
    <div className={`nanocodex-demo is-${mode}`}>
      <div className="agent-runtime-switch" role="group" aria-label="Agent runtime">
        {(["local", "managed"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={runtime === value}
            onClick={() => {
              localStorage.setItem("nanocodex.agent-runtime.v1", value);
              setRuntimeState(undefined);
              setRuntime(value);
            }}
          >
            {value === "local" ? "Local browser" : "Managed durable"}
          </button>
        ))}
      </div>
      <AgentSessionBar
        agentStatus={agentStatus}
        agentError={agentError}
        source={credentialSource}
        capabilityError={activeCapabilityError}
        onAuthStatusChange={setAuthStatus}
        onRetryAgent={retryAgent}
        onSourceChange={changeCredentialSource}
      />
      {hasCredential && !activeCapabilityError ? (
        runtime === "local" ? <AgentTerminal
          authStatus={authStatus}
          mode={mode}
          onStateChange={setRuntimeState}
          source={credentialSource}
          theme={theme}
        /> : <ManagedAgentTerminal
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
  return source === "brokered";
}
