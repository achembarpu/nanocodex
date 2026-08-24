import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ConnectAgent, Connection } from "nanocodex/connect";

import { AgentTerminalView } from "../../src/AgentTerminalView";
import type { AgentTerminalEvent } from "../../src/demoTerminal";
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
  const visibility = connection.grant.visibility;
  const terminalAgent = useMemo(
    () => managedTerminalAgent(agent, { history: visibility.conversationHistory }),
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

  const observeTerminalEvent = useCallback((terminalEvent: AgentTerminalEvent) => {
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
          <h3 id="connect-chat-title">Embedded Nanocodex</h3>
          <p>Account-owned durable agent. Atlas sees only the signed projection.</p>
        </div>
        <span>Durable</span>
      </header>
      <div className="nanocodex-demo is-preview">
        <div className="conversation-workspace">
          <div className="conversation-main">
            <AgentTerminalView
              agent={terminalAgent}
              agentError={undefined}
              mode="preview"
              onConversationActivity={recordActivity}
              onTerminalEvent={observeTerminalEvent}
              onStateChange={recordState}
              retryAgent={retryAgent}
              theme="dark"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
