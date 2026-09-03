import { describe, expect, it, vi } from "vitest";

import type {
  AgentEvent,
  EventWatcher,
  WatchEventsOptions,
} from "nanocodex";
import { watchManagedAgentFamilyEvents } from "../src/agent-event-watcher";

describe("managed agent event watcher", () => {
  it("projects both root and Rust-spawned child sessions", () => {
    let subscribed: ((
      event: AgentEvent,
      encodedLength?: number,
      encodedEvent?: string,
      agentId?: number,
    ) => void) | undefined;
    const off = vi.fn();
    const watcher = {
      onEvent(listener: (event: AgentEvent) => void) {
        subscribed = listener as typeof subscribed;
        return vi.fn();
      },
      off,
      async *[Symbol.asyncIterator]() {},
    } satisfies EventWatcher;
    const watch = vi.fn((_options?: WatchEventsOptions) => watcher);
    const observed: Array<{ event: AgentEvent; agentId: number | undefined }> = [];

    expect(watchManagedAgentFamilyEvents({ events: { watch } }, (event, agentId) => {
      observed.push({ event, agentId });
    })).toBe(watcher);
    expect(watch).toHaveBeenCalledWith({ includeAllSessions: true });

    const root = agentEvent("root-session", 1, "run.started");
    const child = agentEvent("child-session", 1, "tool.call");
    subscribed!(root, undefined, undefined, undefined);
    subscribed!(child, undefined, undefined, 1);

    expect(observed).toEqual([
      { event: root, agentId: undefined },
      { event: child, agentId: 1 },
    ]);
  });
});

function agentEvent(requestId: string, seq: number, type: string): AgentEvent {
  return {
    protocol_version: 1,
    request_id: requestId,
    seq,
    type,
    payload: {},
  };
}
