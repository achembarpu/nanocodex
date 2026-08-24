import { useEffect, useMemo, useState } from "react";
import type { ConnectAgent, Connection } from "nanocodex/connect";

import { AgentTerminalView } from "../../src/AgentTerminalView";
import { ConversationHistoryRail, type ConversationSummary } from "../../src/ConversationHistoryRail";
import type { AgentTerminalState } from "../../src/agentTerminalTypes";
import { managedTerminalAgent } from "../../src/managedAgentRuntime";

export type AppObservation = Readonly<{
  actions: readonly string[];
  finalMessage?: string | undefined;
  historyTurns: number;
  traceEvents: number;
}>;

export function ConnectAgentExperience({
  agent,
  connection,
  onObservation,
}: Readonly<{
  agent: ConnectAgent;
  connection: Connection;
  onObservation(value: AppObservation): void;
}>) {
  const [railOpen, setRailOpen] = useState(false);
  const [terminalState, setTerminalState] = useState<AgentTerminalState>();
  const [summary, setSummary] = useState<ConversationSummary>(() => conversation(agent.id));
  const terminalAgent = useMemo(() => managedTerminalAgent(agent), [agent]);
  const visibility = connection.grant.visibility;

  useEffect(() => {
    let cancelled = false;
    let historyTurns = 0;
    void agent.state().then((state) => {
      if (cancelled) return;
      historyTurns = visibility.conversationHistory ? state.completed_turns : 0;
      setSummary((current) => ({ ...current, turnCount: historyTurns }));
      onObservation({ actions: [], historyTurns, traceEvents: 0 });
    }).catch(() => {});

    const controller = new AbortController();
    const events = agent.events.watch({ cursor: "latest", signal: controller.signal });
    void (async () => {
      let traceEvents = 0;
      try {
        for await (const event of events) {
          if (cancelled) break;
          if (event.data.type === "event") traceEvents += 1;
          if (event.data.type !== "turn_completed") continue;
          if (visibility.conversationHistory) historyTurns += 1;
          setSummary((current) => ({
            ...current,
            turnCount: (current.turnCount ?? 0) + 1,
            updatedAt: Date.now(),
          }));
          onObservation({
            actions: [],
            ...(visibility.finalMessages && event.data.final_message
              ? { finalMessage: event.data.final_message }
              : {}),
            historyTurns,
            traceEvents: visibility.rawTraces ? traceEvents : 0,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("Nanocodex Connect event projection failed", error);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      void events.return?.();
    };
  }, [agent, onObservation, visibility.conversationHistory, visibility.finalMessages, visibility.rawTraces]);

  function recordActivity(input: string) {
    setSummary((current) => ({
      ...current,
      title: current.turnCount ? current.title : conversationTitle(input),
      updatedAt: Date.now(),
    }));
  }

  const agentStatus = terminalState?.status ?? "starting";
  return (
    <section className="connect-chat" aria-labelledby="connect-chat-title">
      <header className="connect-chat-header">
        <div>
          <h3 id="connect-chat-title">Embedded Nanocodex</h3>
          <p>Account-owned durable agent. Atlas sees only the signed projection.</p>
        </div>
        <span>Durable</span>
      </header>
      <div className="nanocodex-demo is-preview">
        <div className="conversation-workspace">
          {visibility.conversationHistory ? (
            <ConversationHistoryRail
              agentStatus={agentStatus}
              conversations={[summary]}
              mobileOpen={railOpen}
              pending={false}
              runtime="managed"
              selectedId={agent.id}
              onClose={() => setRailOpen(false)}
              onOpen={() => setRailOpen(true)}
              onRetry={() => {}}
              onSelect={() => setRailOpen(false)}
            />
          ) : (
            <aside className="private-history" aria-label="Conversation history is private">
              <strong>History</strong>
              <span>Private</span>
            </aside>
          )}
          <div className="conversation-main">
            <AgentTerminalView
              agent={terminalAgent}
              agentError={undefined}
              mode="preview"
              onConversationActivity={recordActivity}
              onStateChange={setTerminalState}
              retryAgent={() => {}}
              theme="dark"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function conversation(id: string): ConversationSummary {
  return { id, title: "New conversation", turnCount: 0, updatedAt: Date.now() };
}

function conversationTitle(input: string) {
  const oneLine = input.trim().replace(/\s+/g, " ");
  return oneLine.length > 42 ? `${oneLine.slice(0, 41)}…` : oneLine || "New conversation";
}
