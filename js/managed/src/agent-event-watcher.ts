import type {
  AgentEvent,
  EventWatcher,
  WatchEventsOptions,
} from "nanocodex";

type AgentEventSource = Readonly<{
  events: Readonly<{
    watch(options?: WatchEventsOptions): EventWatcher;
  }>;
}>;

type InternalEventListener = (
  event: AgentEvent,
  encodedLength?: number,
  encodedEvent?: string,
  agentId?: number,
) => void;

/** Observes the complete Rust-owned agent family for durable projection. */
export function watchManagedAgentFamilyEvents(
  agent: AgentEventSource,
  listener: (event: AgentEvent, agentId: number | undefined) => void,
): EventWatcher {
  const events = agent.events.watch({ includeAllSessions: true });
  const onEvent = events.onEvent as unknown as (
    listener: InternalEventListener,
  ) => () => void;
  onEvent((event, _encodedLength, _encodedEvent, agentId) => {
    listener(event, agentId);
  });
  return events;
}
