import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ConnectAgent, Connection } from "nanocodex/connect";
import type { AgentControllerEvent } from "nanocodex-react/agent";
import { createConnectAgentSource } from "nanocodex-react/connect";

import { AgentTerminalView } from "../../src/AgentTerminalView";

export type AppObservation = Readonly<{
  actions: readonly string[];
  finalMessage?: string | undefined;
  historyTurns: number;
  traceEvents: number;
}>;

export function ConnectAgentExperience({
  agent,
  connection,
  isMutating,
  onLogout,
  onOpenDetails,
  onObservation,
}: Readonly<{
  agent: ConnectAgent;
  connection: Connection;
  isMutating: boolean;
  onLogout(): void;
  onOpenDetails(): void;
  onObservation(value: AppObservation): void;
}>) {
  const visibility = connection.grant.visibility;
  const terminalAgent = useMemo(
    () => createConnectAgentSource(agent, { history: visibility.conversationHistory }),
    [agent, visibility.conversationHistory],
  );
  const retryAgent = useCallback(() => {}, []);
  const recordActivity = useCallback(() => {}, []);
  const recordState = useCallback(() => {}, []);
  const observation = useRef<AppObservation>({ actions: [], historyTurns: 0, traceEvents: 0 });

  useEffect(() => {
    observation.current = { actions: [], historyTurns: 0, traceEvents: 0 };
    onObservation(observation.current);
  }, [agent, onObservation]);

  const observeTerminalEvent = useCallback((terminalEvent: AgentControllerEvent) => {
    let next = observation.current;
    if (terminalEvent.type === "prompt.completed" && visibility.finalMessages) {
      const finalMessage = typeof terminalEvent.finalMessage === "string"
        ? terminalEvent.finalMessage
        : undefined;
      next = {
        ...next,
        ...(finalMessage ? { finalMessage } : {}),
        historyTurns: visibility.conversationHistory ? next.historyTurns + 1 : 0,
      };
    } else if (terminalEvent.type === "agent.history") {
      const events = Array.isArray(terminalEvent.events) ? terminalEvent.events : [];
      next = {
        ...next,
        historyTurns: visibility.conversationHistory
          ? events.filter((event) => event && typeof event === "object"
            && !Array.isArray(event) && (event as { type?: unknown }).type === "run.completed").length
          : 0,
        traceEvents: visibility.rawTraces ? events.length : 0,
      };
    } else if (terminalEvent.type === "agent.event") {
      const event = terminalEvent.event;
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const type = (event as { type?: unknown }).type;
      const actions = visibility.actionSummaries
        && typeof type === "string"
        && (type === "tool.call" || type === "tool.result")
        ? [...next.actions, type]
        : next.actions;
      next = {
        ...next,
        actions,
        traceEvents: visibility.rawTraces ? next.traceEvents + 1 : 0,
      };
    } else {
      return;
    }
    observation.current = next;
    onObservation(next);
  }, [onObservation, visibility.actionSummaries, visibility.conversationHistory, visibility.finalMessages, visibility.rawTraces]);

  return (
    <section className="connect-chat" aria-labelledby="connect-chat-title">
      <header className="connect-chat-header">
        <div>
          <h3 id="connect-chat-title">Nanocodex</h3>
          <p>Durable agent · scoped by Atlas</p>
        </div>
        <div className="connect-chat-actions">
          <span className="connect-agent-status">Live</span>
          <button
            className="connect-sign-out"
            disabled={isMutating}
            onClick={onLogout}
            type="button"
          >
            Sign out
          </button>
          <button className="connection-rail-open" onClick={onOpenDetails} type="button">
            Details
          </button>
        </div>
      </header>
      <div className="nanocodex-demo is-preview">
        <div className="conversation-workspace">
          <div className="conversation-main">
            <AgentTerminalView
              agent={terminalAgent}
              agentError={undefined}
              maxEntries={visibility.conversationHistory ? Number.MAX_SAFE_INTEGER : undefined}
              mode="preview"
              onConversationActivity={recordActivity}
              onTerminalEvent={observeTerminalEvent}
              onStateChange={recordState}
              retryAgent={retryAgent}
              showToolCalls={visibility.rawTraces}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
