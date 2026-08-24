import { useCallback, useEffect, useMemo } from "react";
import type { ConnectAgent, Connection } from "nanocodex/connect";

import { AgentTerminalView } from "../../src/AgentTerminalView";
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

  useEffect(() => {
    let cancelled = false;
    let historyTurns = 0;
    if (visibility.conversationHistory) {
      void agent.state().then((state) => {
        if (cancelled) return;
        historyTurns = state.completed_turns;
        onObservation({ actions: [], historyTurns, traceEvents: 0 });
      }).catch(() => {});
    } else {
      onObservation({ actions: [], historyTurns: 0, traceEvents: 0 });
    }

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
