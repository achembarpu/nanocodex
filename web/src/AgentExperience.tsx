import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus, AgentTerminalMode, AgentTerminalState } from "./agentTerminalTypes";
import { AgentTerminal, ManagedAgentTerminal } from "./AgentTerminal";
import { TerminalTranscriptSurface } from "nanocodex-terminal";
import { useAccountSession } from "./AccountSession";
import { ConversationHistoryRail } from "./ConversationHistoryRail";
import { browserAgentCapabilityError } from "./browserAgentCapabilities";
import { clientFailureMessage } from "./clientFailure";
import {
  inactiveTerminalMessage,
  useModelSession,
  type ModelSessionStatus,
  type CredentialSource,
} from "./modelSession";
import { conversationTitle } from "./localConversationRuntime";
import {
  createManagedConversation,
  listManagedConversations,
  type ManagedConversation,
} from "./managedAgentRuntime";
import "./AgentTerminal.css";
import "nanocodex-terminal/styles.css";
import "./Home.css";

/** Ephemeral homepage consumer and managed-durable Agent demo. */
export const AgentExperience = memo(function AgentExperience({
  beforeLocalTurn, deploymentCurrent, landing, mode,
}: {
  beforeLocalTurn(): Promise<void>;
  deploymentCurrent: boolean;
  landing?: boolean;
  mode: AgentTerminalMode;
}) {
  const [ephemeralThreadId] = useState(() => crypto.randomUUID());
  const account = useAccountSession();
  const capabilityError = useMemo(() => browserAgentCapabilityError(), []);
  const [authStatus, setAuthStatus] = useState<ModelSessionStatus>();
  const [credentialSource, setCredentialSource] = useState<CredentialSource>();
  const credentialSourceRef = useRef<CredentialSource | undefined>(undefined);
  const [runtimeState, setRuntimeState] = useState<AgentTerminalState>();
  const [railOpen, setRailOpen] = useState(false);
  const [managedConversations, setManagedConversations] = useState<readonly ManagedConversation[]>([]);
  const [managedConversationId, setManagedConversationId] = useState<string>();
  const [managedError, setManagedError] = useState<string>();
  const [managedAttempt, setManagedAttempt] = useState(0);
  const [conversationPending, setConversationPending] = useState(false);
  const hasCredential = credentialSource === "brokered";

  useEffect(() => {
    if (!landing || deploymentCurrent || authStatus?.state !== "ready") return;
    void beforeLocalTurn().catch(() => {});
  }, [authStatus, beforeLocalTurn, deploymentCurrent, landing]);
  useEffect(() => {
    setManagedConversations([]);
    setManagedConversationId(undefined);
    setRuntimeState(undefined);
  }, [account.account?.id]);
  useEffect(() => {
    if (landing || account.status !== "ready" || !account.account) return;
    let cancelled = false;
    const accountId = account.account.id;
    const retainedId = safeGet(managedSelectionKey(accountId)) ?? undefined;
    setManagedConversationId(retainedId);
    setConversationPending(true);
    setManagedError(undefined);
    void listManagedConversations(accountId).then(async (listed) => {
      if (cancelled) return;
      const next = listed.length || !hasCredential ? listed : [await createManagedConversation(accountId)];
      if (cancelled) return;
      const selected = next.find(({ id }) => id === retainedId)?.id ?? next[0]?.id;
      setManagedConversations(next);
      setManagedConversationId(selected);
      if (selected) safeSet(managedSelectionKey(accountId), selected);
    }).catch((error) => {
      if (!cancelled) setManagedError(errorMessage(error));
    }).finally(() => {
      if (!cancelled) setConversationPending(false);
    });
    return () => { cancelled = true; };
  }, [account.account?.id, account.status, hasCredential, landing, managedAttempt]);

  const changeCredentialSource = useCallback((source: CredentialSource) => {
    if (credentialSourceRef.current === "brokered" && source !== "brokered") setRuntimeState(undefined);
    credentialSourceRef.current = source;
    setCredentialSource(source);
  }, []);
  useModelSession({
    onStatusChange: setAuthStatus,
    onSourceChange: changeCredentialSource,
  });
  const activeCapabilityError = landing ? capabilityError : undefined;
  const agentStatus: AgentStatus = !hasCredential || activeCapabilityError
    ? "idle" : runtimeState?.status ?? "starting";
  const agentError = runtimeState?.error;
  const inactiveMessage = inactiveTerminalMessage({
    agentError, agentStatus, authStatus, capabilityError: activeCapabilityError,
    runtime: landing ? "browser" : "managed", source: credentialSource,
  });

  const selectManaged = useCallback((id: string) => {
    setManagedConversationId(id);
    if (account.account) safeSet(managedSelectionKey(account.account.id), id);
    setRuntimeState(undefined);
    setRailOpen(false);
  }, [account.account]);
  const createConversation = useCallback(() => {
    if (conversationPending || !account.account) return;
    setConversationPending(true);
    setManagedError(undefined);
    void createManagedConversation(account.account.id).then((conversation) => {
      setManagedConversations((current) => [conversation, ...current]);
      setManagedConversationId(conversation.id);
      safeSet(managedSelectionKey(account.account!.id), conversation.id);
      setRuntimeState(undefined);
      setRailOpen(false);
    }).catch((error) => setManagedError(errorMessage(error)))
      .finally(() => setConversationPending(false));
  }, [account.account, conversationPending]);
  const retryManagedConversations = useCallback(() => {
    setManagedError(undefined);
    setManagedAttempt((value) => value + 1);
  }, []);
  const recordActivity = useCallback((input: string) => {
    if (!managedConversationId) return;
    setManagedConversations((current) => current.map((item) => item.id === managedConversationId ? {
      ...item,
      title: (item.turnCount ?? 0) === 0 ? conversationTitle(input) : item.title,
      turnCount: (item.turnCount ?? 0) + 1,
      updatedAt: Date.now(),
    } : item).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
  }, [managedConversationId]);

  return <div className={`nanocodex-demo is-${mode}${landing ? " is-landing" : ""}`}>
    <div className="conversation-workspace">
      {landing ? null : <ConversationHistoryRail
        agentStatus={agentStatus}
        conversations={managedConversations} error={managedError}
        mobileOpen={railOpen} pending={conversationPending} runtime="managed" selectedId={managedConversationId}
        onClose={() => setRailOpen(false)} onCreate={createConversation} onOpen={() => setRailOpen(true)}
        onRetry={retryManagedConversations}
        onSelect={selectManaged}
      />}
      <div className="conversation-main">
        {landing
          ? hasCredential && !activeCapabilityError && deploymentCurrent
            ? <AgentTerminal
              key={`ephemeral:${ephemeralThreadId}`}
              authStatus={authStatus} beforeLocalTurn={beforeLocalTurn}
              mode={mode} onConversationActivity={NO_CONVERSATION_ACTIVITY}
              onStateChange={setRuntimeState} source={credentialSource} threadId={ephemeralThreadId}
              welcome={HOME_TERMINAL_WELCOME}
            />
            : <ReservedTerminal message={inactiveMessage} mode={mode} welcome={HOME_TERMINAL_WELCOME} />
          : hasCredential && managedConversationId
            ? <ManagedAgentTerminal
              key={managedConversationId} agentId={managedConversationId!} authStatus={authStatus}
              mode={mode} onConversationActivity={recordActivity} onStateChange={setRuntimeState}
              source={credentialSource}
            />
            : <ReservedTerminal message={inactiveMessage} mode={mode} />}
      </div>
    </div>
  </div>;
});

function ReservedTerminal({
  message,
  mode,
  welcome,
}: {
  message: string;
  mode: AgentTerminalMode;
  welcome?: string;
}) {
  return <TerminalTranscriptSurface
    canLoadOlder={false}
    composer={null}
    entries={[]}
    inactiveMessage={message}
    isLoadingOlder={false}
    mode={mode}
    status="idle"
    welcome={welcome}
    onLoadOlder={NO_OLDER_HISTORY}
  />;
}

const NO_OLDER_HISTORY = async () => false;
const NO_CONVERSATION_ACTIVITY = () => {};

const HOME_TERMINAL_WELCOME = `# High-performance Codex SDK. Runs anywhere.

\`curl -fsSL https://nanocodex.paradigm.xyz | bash\`

Rust · Node · browser WASM
One agent keeps its WebSocket, typed history, tools, and context across turns.

**Terminal-Bench 2.1 high · 82.2% · 890/890 runs**

This is the local browser agent. Ask Nanocodex to do something.`;

function managedSelectionKey(accountId: string) {
  return `nanocodex.managed-conversation.v2.${accountId}`;
}
function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}
function errorMessage(error: unknown) {
  return clientFailureMessage(
    error,
    "Managed agents could not be reached. Check your network and retry.",
  );
}
