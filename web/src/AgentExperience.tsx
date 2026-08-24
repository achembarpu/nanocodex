import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectBrowserThread } from "nanocodex/tools/browser";
import type { AgentStatus, AgentTerminalMode, AgentTerminalState } from "./agentTerminalTypes";
import { AgentTerminal, ManagedAgentTerminal } from "./AgentTerminal";
import { TerminalTranscriptSurface } from "./AgentTerminalView";
import { useAccountSession } from "./AccountSession";
import { ConversationHistoryRail, type ConversationSummary } from "./ConversationHistoryRail";
import { browserAgentCapabilityError } from "./browserAgentCapabilities";
import { clientFailureMessage } from "./clientFailure";
import {
  AgentSessionBar,
  inactiveTerminalMessage,
  type ModelSessionStatus,
  type CredentialSource,
} from "./modelSession";
import {
  conversationTitle,
  createLocalConversation,
  loadLocalConversations,
  recordLocalConversationPrompt,
  type LocalConversation,
} from "./localConversationRuntime";
import {
  createManagedConversation,
  listManagedConversations,
  type ManagedConversation,
} from "./managedAgentRuntime";
import "./AgentTerminal.css";
import "./Home.css";

/** Account-aware shell around the local and managed Agent consumers. */
export const AgentExperience = memo(function AgentExperience({
  beforeLocalTurn, deploymentCurrent, landing, mode, onThreadChange, threadId,
}: {
  beforeLocalTurn(): Promise<void>;
  deploymentCurrent: boolean;
  landing?: boolean;
  mode: AgentTerminalMode;
  onThreadChange(threadId: string): void;
  threadId?: string;
}) {
  const [ephemeralThreadId] = useState(() => crypto.randomUUID());
  const durable = !landing && threadId !== undefined;
  const activeThreadId = landing || threadId === undefined ? ephemeralThreadId : threadId;
  const account = useAccountSession();
  const capabilityError = useMemo(() => browserAgentCapabilityError(), []);
  const [runtime, setRuntime] = useState<"local" | "managed">(() =>
    localStorage.getItem("nanocodex.agent-runtime.v1") === "managed" ? "managed" : "local"
  );
  const activeRuntime = landing ? "local" : runtime;
  const [authStatus, setAuthStatus] = useState<ModelSessionStatus>();
  const [credentialSource, setCredentialSource] = useState<CredentialSource>();
  const credentialSourceRef = useRef<CredentialSource | undefined>(undefined);
  const [runtimeState, setRuntimeState] = useState<AgentTerminalState>();
  const [railOpen, setRailOpen] = useState(false);
  const [localConversations, setLocalConversations] = useState<readonly LocalConversation[]>(() =>
    durable ? loadLocalConversations(activeThreadId) : []
  );
  const [managedConversations, setManagedConversations] = useState<readonly ManagedConversation[]>([]);
  const [managedConversationId, setManagedConversationId] = useState<string>();
  const [managedError, setManagedError] = useState<string>();
  const [managedAttempt, setManagedAttempt] = useState(0);
  const [conversationPending, setConversationPending] = useState(false);
  const hasCredential = credentialSource === "brokered";

  useEffect(() => {
    setLocalConversations(durable ? loadLocalConversations(activeThreadId) : []);
  }, [activeThreadId, durable]);
  useEffect(() => {
    if (deploymentCurrent || authStatus?.state !== "ready") return;
    void beforeLocalTurn().catch(() => {});
  }, [authStatus, beforeLocalTurn, deploymentCurrent]);
  useEffect(() => {
    setManagedConversations([]);
    setManagedConversationId(undefined);
    setRuntimeState(undefined);
  }, [account.account?.id]);
  useEffect(() => {
    if (activeRuntime !== "managed" || account.status !== "ready" || !account.account) return;
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
  }, [account.account?.id, account.status, activeRuntime, hasCredential, managedAttempt]);

  const changeCredentialSource = useCallback((source: CredentialSource) => {
    if (credentialSourceRef.current === "brokered" && source !== "brokered") setRuntimeState(undefined);
    credentialSourceRef.current = source;
    setCredentialSource(source);
  }, []);
  const activeCapabilityError = activeRuntime === "local" ? capabilityError : undefined;
  const agentStatus: AgentStatus = !hasCredential || activeCapabilityError
    ? "idle" : runtimeState?.status ?? "starting";
  const agentError = runtimeState?.error;
  const retryAgent = useCallback(() => runtimeState?.retry(), [runtimeState]);
  const inactiveMessage = inactiveTerminalMessage({
    agentError, agentStatus, authStatus, capabilityError: activeCapabilityError, source: credentialSource,
  });

  const selectLocal = useCallback((id: string) => {
    selectBrowserThread(id);
    onThreadChange(id);
    setRuntimeState(undefined);
    setRailOpen(false);
  }, [onThreadChange]);
  const selectManaged = useCallback((id: string) => {
    setManagedConversationId(id);
    if (account.account) safeSet(managedSelectionKey(account.account.id), id);
    setRuntimeState(undefined);
    setRailOpen(false);
  }, [account.account]);
  const createConversation = useCallback(() => {
    if (conversationPending) return;
    if (activeRuntime === "local") {
      const created = createLocalConversation(localConversations);
      setLocalConversations(created.conversations);
      selectBrowserThread(created.conversation.id);
      onThreadChange(created.conversation.id);
      setRuntimeState(undefined);
      setRailOpen(false);
      return;
    }
    if (!account.account) return;
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
  }, [account.account, activeRuntime, conversationPending, localConversations, onThreadChange]);
  const retryManagedConversations = useCallback(() => {
    setManagedError(undefined);
    setManagedAttempt((value) => value + 1);
  }, []);
  const recordActivity = useCallback((input: string) => {
    if (activeRuntime === "local") {
      if (durable) {
        setLocalConversations((current) =>
          recordLocalConversationPrompt(current, activeThreadId, input)
        );
      }
      return;
    }
    if (!managedConversationId) return;
    setManagedConversations((current) => current.map((item) => item.id === managedConversationId ? {
      ...item,
      title: (item.turnCount ?? 0) === 0 ? conversationTitle(input) : item.title,
      turnCount: (item.turnCount ?? 0) + 1,
      updatedAt: Date.now(),
    } : item).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
  }, [activeRuntime, activeThreadId, durable, managedConversationId]);

  const conversations: readonly ConversationSummary[] = activeRuntime === "local"
    ? localConversations : managedConversations;
  const selectedId = activeRuntime === "local" ? activeThreadId : managedConversationId;
  return <div className={`nanocodex-demo is-${mode}${landing ? " is-landing" : ""}`}>
    {landing ? null : <div className="agent-runtime-switch" role="group" aria-label="Agent runtime">
      {(["local", "managed"] as const).map((value) => <button
        key={value} type="button" aria-pressed={runtime === value}
        onClick={() => {
          localStorage.setItem("nanocodex.agent-runtime.v1", value);
          setRuntimeState(undefined);
          setRuntime(value);
          setRailOpen(false);
        }}
      >{value === "local" ? "Local browser" : "Managed durable"}</button>)}
    </div>}
    <AgentSessionBar
      agentStatus={agentStatus} agentError={agentError} source={credentialSource}
      capabilityError={activeCapabilityError} onAuthStatusChange={setAuthStatus}
      onRetryAgent={retryAgent} onSourceChange={changeCredentialSource}
    />
    <div className="conversation-workspace">
      {landing ? null : <ConversationHistoryRail
        agentStatus={agentStatus}
        conversations={conversations} error={activeRuntime === "managed" ? managedError : undefined}
        mobileOpen={railOpen} pending={conversationPending} runtime={activeRuntime} selectedId={selectedId}
        onClose={() => setRailOpen(false)} onCreate={createConversation} onOpen={() => setRailOpen(true)}
        onRetry={retryManagedConversations}
        onSelect={activeRuntime === "local" ? selectLocal : selectManaged}
      />}
      <div className="conversation-main">
        {hasCredential && !activeCapabilityError
          && (activeRuntime === "managed" || deploymentCurrent)
          && (activeRuntime === "local" || managedConversationId)
          ? activeRuntime === "local" ? <AgentTerminal
              key={`${durable ? "durable" : "ephemeral"}:${activeThreadId}`}
              authStatus={authStatus} beforeLocalTurn={beforeLocalTurn}
              durable={durable}
              mode={mode} onConversationActivity={recordActivity}
              onStateChange={setRuntimeState} source={credentialSource} threadId={activeThreadId}
              welcome={landing ? HOME_TERMINAL_WELCOME : undefined}
            /> : <ManagedAgentTerminal
              key={managedConversationId} agentId={managedConversationId!} authStatus={authStatus}
              mode={mode} onConversationActivity={recordActivity} onStateChange={setRuntimeState}
              source={credentialSource}
            />
          : <ReservedTerminal
              message={inactiveMessage}
              mode={mode}
              welcome={landing ? HOME_TERMINAL_WELCOME : undefined}
            />}
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
