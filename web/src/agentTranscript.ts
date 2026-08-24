import type { AgentEvent } from "nanocodex";

export type ToolStatus = "running" | "completed" | "cancelled" | "failed";

export type ToolActivity = {
  callId: string;
  name: string;
  arguments: string;
  result?: string;
  status: ToolStatus;
  durationNs?: number;
  images?: string[];
  children: ToolActivity[];
};

export type PlanUpdate = {
  explanation?: string;
  plan: { step: string; status: "pending" | "in_progress" | "completed" }[];
};

export type TerminalEntry = (
  | { id: string; kind: "user"; text: string; promptId?: number }
  | { id: string; kind: "reasoning"; text: string; streaming: boolean }
  | { id: string; kind: "assistant"; text: string; streaming: boolean }
  | { id: string; kind: "tool"; tool: ToolActivity }
  | { id: string; kind: "plan"; update: PlanUpdate }
  | { id: string; kind: "error"; text: string }
) & { turnId?: string };

type PendingSteer = {
  id: number;
  text: string;
  state: "submitting" | "admitted";
  runGeneration: number;
};

type PendingPrompt = { id: number; text: string; historyEntryId?: string; turnId?: string };

export type TerminalState = {
  entries: TerminalEntry[];
  running: boolean;
  status: string;
  pendingTurns: number;
  queuedPrompts: PendingPrompt[];
  displayedQueuedPrompt?: number;
  pendingSteers: PendingSteer[];
  appliedSteerRuns: number[];
  runGeneration: number;
  activeTurnId?: string;
  streamedThisTurn: boolean;
  pendingRunError?: string;
  modelCalls: number;
  syntheticId: number;
};

/** Transcript state used only by the website's ANSI Agent demo. */
export function initialTerminalState(status = "Ready"): TerminalState {
  return {
    entries: [],
    running: false,
    status,
    pendingTurns: 0,
    queuedPrompts: [],
    pendingSteers: [],
    appliedSteerRuns: [],
    runGeneration: 0,
    streamedThisTurn: false,
    modelCalls: 0,
    syntheticId: 0,
  };
}

export function queuePrompt(
  state: TerminalState,
  id: number,
  text: string,
  historyEntryId?: string,
): TerminalState {
  const displayImmediately = !state.running && state.queuedPrompts.length === 0;
  const turnId = historyTurnId(historyEntryId);
  return {
    ...state,
    entries: displayImmediately
      ? [...state.entries, {
          id: historyEntryId ?? `user-${id}`,
          kind: "user",
          text,
          promptId: id,
          ...(turnId === undefined ? {} : { turnId }),
        }]
      : state.entries,
    queuedPrompts: [...state.queuedPrompts, { id, text, historyEntryId, turnId }],
    displayedQueuedPrompt: displayImmediately ? id : state.displayedQueuedPrompt,
    pendingTurns: state.pendingTurns + 1,
    status: state.running ? "Prompt queued" : "Starting",
  };
}

export function queueSteer(state: TerminalState, id: number, text: string): TerminalState {
  return {
    ...state,
    entries: [...state.entries, {
      id: `steer-${id}`,
      kind: "user",
      text,
      ...(state.activeTurnId === undefined ? {} : { turnId: state.activeTurnId }),
    }],
    pendingSteers: [
      ...state.pendingSteers,
      { id, text, state: "submitting", runGeneration: state.runGeneration },
    ],
    status: "Submitting steer",
  };
}

export function steerAdmitted(state: TerminalState, id: number): TerminalState {
  const pendingSteers = state.pendingSteers.map((steer) =>
    steer.id === id ? { ...steer, state: "admitted" as const } : steer,
  );
  return reconcileSteers({
    ...state,
    pendingSteers,
    status: state.running ? "Steer pending" : state.status,
  });
}

export function steerFailed(state: TerminalState, id: number, error: string): TerminalState {
  return appendError(removeSteer(state, id), error);
}

export function turnFinished(
  state: TerminalState,
  error?: string,
  finalMessage?: string,
  promptId?: number,
  historyEntryId?: string,
): TerminalState {
  const turnId = historyTurnId(historyEntryId);
  let next = {
    ...state,
    pendingTurns: Math.max(0, state.pendingTurns - 1),
    queuedPrompts: promptId === undefined
      ? state.queuedPrompts
      : state.queuedPrompts.filter((prompt) => prompt.id !== promptId),
    displayedQueuedPrompt: state.displayedQueuedPrompt === promptId
      ? undefined
      : state.displayedQueuedPrompt,
  };
  if (finalMessage?.trim()) {
    let userIndex = -1;
    let assistantIndex = -1;
    for (let index = next.entries.length - 1; index >= 0; index -= 1) {
      const entry = next.entries[index];
      if (entry?.kind === "user" && (
        (turnId !== undefined && entry.turnId === turnId)
        || (turnId === undefined && (promptId === undefined || entry.promptId === promptId))
      )) {
        userIndex = index;
        break;
      }
    }
    for (let index = next.entries.length - 1; index > userIndex; index -= 1) {
      const entry = next.entries[index];
      if (entry?.kind === "assistant" && (turnId === undefined || entry.turnId === turnId)) {
        assistantIndex = index;
        break;
      }
    }
    if (assistantIndex >= 0) {
      const assistant = next.entries[assistantIndex];
      if (assistant?.kind === "assistant" && assistant.text !== finalMessage) {
        const entries = next.entries.slice();
        entries[assistantIndex] = { ...assistant, text: finalMessage, streaming: false };
        next = { ...next, entries };
      }
    } else {
      const syntheticId = next.syntheticId + 1;
      next = {
        ...next,
        syntheticId,
        entries: [
          ...next.entries,
          {
            id: `assistant-result-${syntheticId}`,
            kind: "assistant",
            text: finalMessage,
            streaming: false,
            ...(turnId === undefined ? {} : { turnId }),
          },
        ],
      };
    }
  }
  if (!error || error === "the turn was cancelled") return next;
  const tail = next.entries.at(-1);
  return tail?.kind === "error" && tail.text === error ? next : appendError(next, error, turnId);
}

function appendError(state: TerminalState, text: string, turnId = state.activeTurnId): TerminalState {
  const syntheticId = state.syntheticId + 1;
  return {
    ...state,
    syntheticId,
    entries: [...state.entries, {
      id: `error-${syntheticId}`,
      kind: "error",
      text,
      ...(turnId === undefined ? {} : { turnId }),
    }],
  };
}

export function applyAgentEvents(
  state: TerminalState,
  events: readonly AgentEvent[],
): TerminalState {
  if (events.length === 0) return state;

  let next = { ...state };
  let ownsEntries = false;
  let bufferedKind: "assistant" | "reasoning" | undefined;
  let bufferedId = "";
  let bufferedTurnId: string | undefined;
  let bufferedText: string[] = [];

  const mutableEntries = () => {
    if (!ownsEntries) {
      next = { ...next, entries: next.entries.slice() };
      ownsEntries = true;
    }
    return next.entries;
  };

  const sealTail = () => {
    const tail = next.entries.at(-1);
    if (tail && (tail.kind === "assistant" || tail.kind === "reasoning") && tail.streaming) {
      sealStreamingTail(mutableEntries());
    }
  };

  const flushDeltas = () => {
    if (!bufferedKind || bufferedText.length === 0) return;
    const text = bufferedText.join("");
    const entries = mutableEntries();
    const tail = entries.at(-1);
    if (tail?.kind === bufferedKind && tail.streaming) {
      entries[entries.length - 1] = { ...tail, text: tail.text + text };
    } else {
      sealStreamingTail(entries);
      entries.push({
        id: bufferedId,
        kind: bufferedKind,
        text,
        streaming: true,
        ...(bufferedTurnId === undefined ? {} : { turnId: bufferedTurnId }),
      });
    }
    next.streamedThisTurn ||= bufferedKind === "assistant";
    bufferedKind = undefined;
    bufferedId = "";
    bufferedTurnId = undefined;
    bufferedText = [];
  };

  for (const event of events) {
    if (event.type === "assistant.delta" || event.type === "reasoning.summary.delta") {
      const kind = event.type === "assistant.delta" ? "assistant" : "reasoning";
      if (bufferedKind && bufferedKind !== kind) flushDeltas();
      bufferedKind = kind;
      bufferedId ||= `${kind}-${eventIdentity(event)}`;
      bufferedTurnId ??= payloadString(event.payload, "turn_id") ?? next.activeTurnId;
      bufferedText.push(payloadString(event.payload, "text") ?? "");
      continue;
    }
    flushDeltas();

    switch (event.type) {
      case "managed.prompt": {
        const turnId = payloadString(event.payload, "turn_id");
        const text = payloadString(event.payload, "text");
        const id = turnId ? `managed-user-${turnId}` : `managed-user-${event.seq}`;
        if (text && !next.entries.some((entry) => entry.id === id)) {
          mutableEntries().push({
            id,
            kind: "user",
            text,
            ...(turnId === undefined ? {} : { turnId }),
          });
        }
        break;
      }
      case "managed.steer": {
        const turnId = payloadString(event.payload, "turn_id");
        const steerId = payloadString(event.payload, "steer_id") ?? eventIdentity(event);
        const text = payloadString(event.payload, "text");
        const id = `managed-steer-${turnId ?? "unknown"}-${steerId}`;
        if (text && !next.entries.some((entry) => entry.id === id)) {
          mutableEntries().push({
            id,
            kind: "user",
            text,
            ...(turnId === undefined ? {} : { turnId }),
          });
        }
        break;
      }
      case "run.started": {
        const eventTurnId = payloadString(event.payload, "turn_id");
        const promptIndex = eventTurnId === undefined
          ? (next.queuedPrompts.length > 0 ? 0 : -1)
          : next.queuedPrompts.findIndex((queued) => queued.turnId === eventTurnId);
        const prompt = promptIndex < 0 ? undefined : next.queuedPrompts[promptIndex];
        const queuedPrompts = promptIndex < 0
          ? next.queuedPrompts
          : next.queuedPrompts.filter((_, index) => index !== promptIndex);
        const promptEntryId = prompt?.historyEntryId ?? (prompt ? `user-${prompt.id}` : undefined);
        if (prompt
          && next.displayedQueuedPrompt !== prompt.id
          && !next.entries.some((entry) => entry.kind === "user" && (
            prompt.turnId === undefined
              ? entry.id === promptEntryId
              : entry.turnId === prompt.turnId
          ))) {
          mutableEntries().push({
            id: prompt.historyEntryId ?? `user-${prompt.id}`,
            kind: "user",
            text: prompt.text,
            promptId: prompt.id,
            ...(prompt.turnId === undefined ? {} : { turnId: prompt.turnId }),
          });
        }
        next = {
          ...next,
          queuedPrompts,
          displayedQueuedPrompt: prompt && next.displayedQueuedPrompt === prompt.id
            ? undefined
            : next.displayedQueuedPrompt,
          running: true,
          activeTurnId: eventTurnId ?? prompt?.turnId,
          runGeneration: next.runGeneration + 1,
          streamedThisTurn: false,
          pendingRunError: undefined,
          status: "Thinking...",
        };
        break;
      }
      case "run.steered":
        next = reconcileSteers({
          ...next,
          appliedSteerRuns: [...next.appliedSteerRuns, next.runGeneration],
          status: "Steer applied",
        });
        break;
      case "model.warmup.started":
        next.status = "Prewarming model...";
        break;
      case "model.warmup.completed":
        next.status = "Thinking...";
        break;
      case "model.warmup.failed":
        next.status = "Warmup unavailable; continuing";
        break;
      case "model.connection.started":
        next.status = "Connecting...";
        break;
      case "model.call.started":
        next.status = "Thinking...";
        break;
      case "model.attempt.retrying":
        next.status = "Retrying...";
        break;
      case "assistant.message": {
        const text = payloadString(event.payload, "text") ?? "";
        const turnId = payloadString(event.payload, "turn_id") ?? next.activeTurnId;
        const tail = next.entries.at(-1);
        if (tail?.kind === "assistant" && tail.turnId === turnId) {
          const entries = mutableEntries();
          entries[entries.length - 1] = { ...tail, text, streaming: false };
        } else if (text) {
          mutableEntries().push({
            id: `assistant-${eventIdentity(event)}`,
            kind: "assistant",
            text,
            streaming: false,
            ...(turnId === undefined ? {} : { turnId }),
          });
        }
        break;
      }
      case "tool.call": {
        const tool = payloadString(event.payload, "tool") ?? "tool";
        if (isEmptyTerminalPoll(tool, event.payload.arguments)) break;
        if (tool === "update_plan") {
          const update = decodePlanUpdate(event.payload.arguments);
          if (update) {
            const turnId = payloadString(event.payload, "turn_id") ?? next.activeTurnId;
            mutableEntries().push({
              id: `plan-${eventIdentity(event)}`,
              kind: "plan",
              update,
              ...(turnId === undefined ? {} : { turnId }),
            });
            next.status = "Working";
            break;
          }
        }
        applyToolCall(
          mutableEntries(),
          event,
          payloadString(event.payload, "turn_id") ?? next.activeTurnId,
        );
        next.status = `Running ${tool}`;
        break;
      }
      case "tool.result":
        applyToolResult(
          mutableEntries(),
          event,
          payloadString(event.payload, "turn_id") ?? next.activeTurnId,
        );
        next.status = "Working";
        break;
      case "model.call.completed":
        next.modelCalls += 1;
        break;
      case "run.error":
        next.pendingRunError = payloadString(event.payload, "message");
        break;
      case "run.completed":
        sealTail();
        {
          const terminalTurnId = payloadString(event.payload, "turn_id") ?? next.activeTurnId;
        if (next.pendingRunError && !hasProjectedError(
          next.entries,
          next.pendingRunError,
          terminalTurnId,
        )) {
          next = appendError(next, next.pendingRunError, terminalTurnId);
          ownsEntries = true;
        }
        next = reconcileSteers({
          ...next,
          running: false,
          activeTurnId: undefined,
          pendingRunError: undefined,
          status: "Ready",
        });
        ownsEntries = true;
        }
        break;
      case "run.failed": {
        sealTail();
        const cancelled = payloadString(event.payload, "status") === "cancelled";
        const terminalTurnId = payloadString(event.payload, "turn_id") ?? next.activeTurnId;
        if (!cancelled && next.pendingRunError && !hasProjectedError(
          next.entries,
          next.pendingRunError,
          terminalTurnId,
        )) {
          next = appendError(next, next.pendingRunError, terminalTurnId);
          ownsEntries = true;
        }
        next = reconcileSteers({
          ...next,
          running: false,
          activeTurnId: undefined,
          pendingRunError: undefined,
          status: cancelled ? "Cancelled" : "Turn failed",
        });
        ownsEntries = true;
        break;
      }
    }
  }
  flushDeltas();
  return next;
}

export function mergeAgentHistoryEntries(
  current: readonly TerminalEntry[],
  historical: readonly TerminalEntry[],
  previouslyProjectedKeys: ReadonlySet<string>,
): TerminalEntry[] {
  const historicalGroups = transcriptTurnGroups(historical);
  const historicalKeys = historyGroupEntryKeys(historicalGroups);
  const currentGroups = transcriptTurnGroups(current).flatMap((group) => {
    const entries = group.entries.filter((entry) => {
      const key = historyEntryKey(group.turnId, entry);
      return !previouslyProjectedKeys.has(key) && !historicalKeys.has(key);
    });
    return entries.length === 0 ? [] : [{ ...group, entries }];
  });
  const historicalKinds = new Map<string, Set<TerminalEntry["kind"]>>();
  for (const group of historicalGroups) {
    if (!group.turnId) continue;
    historicalKinds.set(group.turnId, new Set(group.entries.map((entry) => entry.kind)));
  }

  const merged: TerminalEntry[] = [];
  const emittedCurrentTurns = new Set<string>();
  for (const group of historicalGroups) {
    if (!group.turnId) {
      merged.push(...group.entries);
      continue;
    }
    const live = currentGroups.find((candidate) => candidate.turnId === group.turnId);
    if (!live) {
      merged.push(...group.entries);
      continue;
    }
    const replacedKinds = historicalKinds.get(group.turnId) ?? new Set();
    const liveEntries = live.entries.filter((entry) => (
      entry.kind !== "user"
      && !(entry.kind === "assistant" && replacedKinds.has("assistant"))
    ));
    const finalAssistant = group.entries.findIndex((entry) => entry.kind === "assistant");
    if (finalAssistant < 0) {
      merged.push(...group.entries, ...liveEntries);
    } else {
      merged.push(
        ...group.entries.slice(0, finalAssistant),
        ...liveEntries,
        ...group.entries.slice(finalAssistant),
      );
    }
    emittedCurrentTurns.add(group.turnId);
  }
  for (const group of currentGroups) {
    if (group.turnId && emittedCurrentTurns.has(group.turnId)) continue;
    merged.push(...group.entries);
  }
  return merged;
}

export function agentHistoryEntryKeys(entries: readonly TerminalEntry[]): ReadonlySet<string> {
  return historyGroupEntryKeys(transcriptTurnGroups(entries));
}

function historyGroupEntryKeys(
  groups: readonly { turnId?: string; entries: readonly TerminalEntry[] }[],
): Set<string> {
  const keys = new Set<string>();
  for (const group of groups) {
    for (const entry of group.entries) keys.add(historyEntryKey(group.turnId, entry));
  }
  return keys;
}

function historyEntryKey(turnId: string | undefined, entry: TerminalEntry): string {
  return turnId === undefined ? `unowned\0${entry.id}` : `turn\0${turnId}\0${entry.id}`;
}

function transcriptTurnGroups(entries: readonly TerminalEntry[]): Array<{
  turnId?: string;
  entries: TerminalEntry[];
}> {
  const groups: Array<{ turnId?: string; entries: TerminalEntry[] }> = [];
  const ownedGroups = new Map<string, { turnId?: string; entries: TerminalEntry[] }>();
  let inferredTurnId: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "user") inferredTurnId = entry.turnId ?? historyTurnId(entry.id);
    const turnId = entry.turnId ?? inferredTurnId;
    if (turnId !== undefined) {
      const retained = ownedGroups.get(turnId);
      if (retained) retained.entries.push(entry);
      else {
        const group = { turnId, entries: [entry] };
        ownedGroups.set(turnId, group);
        groups.push(group);
      }
      continue;
    }
    const tail = groups.at(-1);
    if (!tail || tail.turnId !== undefined) groups.push({ entries: [entry] });
    else tail.entries.push(entry);
  }
  return groups;
}

function hasProjectedError(
  entries: readonly TerminalEntry[],
  text: string,
  turnId: string | undefined,
): boolean {
  return entries.some((entry) => entry.kind === "error"
    && entry.text === text
    && entry.turnId === turnId);
}

function historyTurnId(historyEntryId?: string): string | undefined {
  const prefix = "managed-user-";
  return historyEntryId?.startsWith(prefix) ? historyEntryId.slice(prefix.length) : undefined;
}

function reconcileSteers(state: TerminalState): TerminalState {
  const pendingSteers = state.pendingSteers.slice();
  const appliedSteerRuns = state.appliedSteerRuns.slice();
  const entries = state.entries.slice();
  let applied = 0;
  while (appliedSteerRuns.length > 0) {
    const generation = appliedSteerRuns[0];
    const index = pendingSteers.findIndex(
      (steer) => steer.runGeneration === generation && steer.state === "admitted",
    );
    if (index < 0) break;
    const [steer] = pendingSteers.splice(index, 1);
    if (!steer) break;
    if (!entries.some((entry) => entry.id === `steer-${steer.id}`)) {
      entries.push({
        id: `steer-${steer.id}`,
        kind: "user",
        text: steer.text,
        ...(state.activeTurnId === undefined ? {} : { turnId: state.activeTurnId }),
      });
    }
    appliedSteerRuns.shift();
    applied += 1;
  }
  if (!state.running) {
    const waiting = new Set(appliedSteerRuns);
    return {
      ...state,
      entries,
      pendingSteers: pendingSteers.filter((steer) => waiting.has(steer.runGeneration)),
      appliedSteerRuns,
      status: applied ? "Steer applied" : state.status,
    };
  }
  return { ...state, entries, pendingSteers, appliedSteerRuns };
}

function removeSteer(state: TerminalState, id: number): TerminalState {
  return { ...state, pendingSteers: state.pendingSteers.filter((steer) => steer.id !== id) };
}

function eventIdentity(event: AgentEvent): string {
  return payloadString(event.payload, "managed_event_cursor") ?? String(event.seq);
}

function applyToolCall(
  entries: TerminalEntry[],
  event: AgentEvent,
  turnId: string | undefined,
): void {
  const callId = payloadString(event.payload, "call_id") ?? `tool-${eventIdentity(event)}`;
  const name = payloadString(event.payload, "tool") ?? "tool";
  const tool: ToolActivity = {
    callId,
    name,
    arguments: summarizeToolArguments(name, event.payload.arguments),
    status: "running",
    children: [],
  };
  const parentId = callId.split("/code-")[0];
  if (parentId !== callId) {
    let parentIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.kind === "tool"
        && entry.tool.callId === parentId
        && (turnId === undefined || entry.turnId === turnId)) {
        parentIndex = index;
        break;
      }
    }
    const parent = entries[parentIndex];
    if (parent?.kind === "tool") {
      entries[parentIndex] = {
        ...parent,
        tool: { ...parent.tool, children: [...parent.tool.children, tool] },
      };
      return;
    }
  }
  entries.push({
    id: `tool-${callId}`,
    kind: "tool",
    tool,
    ...(turnId === undefined ? {} : { turnId }),
  });
}

function isEmptyTerminalPoll(tool: string, value: unknown): boolean {
  return tool === "write_stdin"
    && isObject(value)
    && (typeof value.chars !== "string" || value.chars.length === 0);
}

function decodePlanUpdate(value: unknown): PlanUpdate | undefined {
  if (!isObject(value) || !Array.isArray(value.plan)) return undefined;
  const plan = value.plan.flatMap((item) => {
    if (!isObject(item) || typeof item.step !== "string") return [];
    const status = item.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return [];
    return [{ step: item.step, status } satisfies PlanUpdate["plan"][number]];
  });
  if (plan.length !== value.plan.length) return undefined;
  return {
    ...(typeof value.explanation === "string" ? { explanation: value.explanation } : {}),
    plan,
  };
}

function applyToolResult(
  entries: TerminalEntry[],
  event: AgentEvent,
  turnId: string | undefined,
): void {
  const callId = payloadString(event.payload, "call_id");
  if (!callId) return;
  const statusValue = payloadString(event.payload, "status");
  const status: ToolStatus = statusValue === "cancelled"
    ? "cancelled"
    : statusValue === "completed"
      ? "completed"
      : "failed";
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "tool" || (turnId !== undefined && entry.turnId !== turnId)) continue;
    if (entry.tool.callId === callId) {
      entries[index] = { ...entry, tool: completedTool(entry.tool, event, status) };
      return;
    }
    const childIndex = entry.tool.children.findIndex((child) => child.callId === callId);
    if (childIndex >= 0) {
      const children = entry.tool.children.slice();
      children[childIndex] = completedTool(children[childIndex]!, event, status);
      entries[index] = { ...entry, tool: { ...entry.tool, children } };
      return;
    }
  }
}

function completedTool(
  tool: ToolActivity,
  event: AgentEvent,
  status: ToolStatus,
): ToolActivity {
  const images = extractImageUrls(event.payload.result);
  return {
    ...tool,
    status,
    durationNs: payloadNumber(event.payload, "duration_ns"),
    ...(images ? { images } : {}),
    result: summarizeToolResult(tool.name, event.payload.result, status),
  };
}

function extractImageUrls(value: unknown): string[] | undefined {
  const decoded = decodeJsonString(value);
  if (!Array.isArray(decoded)) return undefined;
  const images = decoded.flatMap((item) => {
    if (!isObject(item) || item.type !== "input_image" || typeof item.image_url !== "string") {
      return [];
    }
    return [item.image_url];
  });
  return images.length ? images : undefined;
}

function sealStreamingTail(entries: TerminalEntry[]): void {
  const tail = entries.at(-1);
  if (tail && (tail.kind === "assistant" || tail.kind === "reasoning") && tail.streaming) {
    entries[entries.length - 1] = { ...tail, streaming: false };
  }
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  return typeof payload[key] === "string" ? payload[key] : undefined;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | undefined {
  return typeof payload[key] === "number" ? payload[key] : undefined;
}

function summarizeToolArguments(tool: string, value: unknown): string {
  if (tool === "exec" && typeof value === "string") return boundedMultiline(value);
  if (isObject(value)) {
    if (tool === "write_stdin" && value.session_id !== undefined) {
      return `session ${String(value.session_id)}`;
    }
    const preferred = tool === "exec_command"
      ? value.cmd
      : tool === "view_image"
        ? value.path
        : tool === "read_file"
          ? value.path ?? value.file_path
          : tool === "wait"
            ? value.cell_id
            : undefined;
    if (typeof preferred === "string") {
      return tool === "exec_command" && preferred.includes("\n")
        ? boundedMultiline(preferred)
        : compact(preferred);
    }
  }
  if (tool === "apply_patch" && typeof value === "string") {
    const lines = value.split("\n");
    const files = lines.flatMap((line) => {
      const prefix = ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
        .find((candidate) => line.startsWith(candidate));
      return prefix ? [line.slice(prefix.length)] : [];
    });
    if (files.length) {
      const added = lines.filter((line) => line.startsWith("+")).length;
      const removed = lines.filter((line) => line.startsWith("-")).length;
      return compact(`${files.join(", ")} (+${added} -${removed})`);
    }
  }
  return compact(formatValue(value));
}

function summarizeToolResult(
  tool: string,
  value: unknown,
  status: ToolStatus,
): string | undefined {
  if (tool === "exec_command") {
    const decoded = decodeJsonString(value);
    if (isObject(decoded)) {
      const parts: string[] = [];
      if (typeof decoded.exit_code === "number") parts.push(`exit ${decoded.exit_code}`);
      if (typeof decoded.output === "string") {
        const lines = decoded.output ? decoded.output.split("\n").length : 0;
        if (lines) parts.push(`${lines} line${lines === 1 ? "" : "s"}`);
      }
      if (parts.length) return parts.join(" · ");
    }
  }
  if (tool === "apply_patch" && typeof value === "string" && value.includes("Success")) {
    return "applied";
  }
  return status === "failed" || status === "cancelled"
    ? compact(formatValue(value))
    : undefined;
}

function decodeJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function compact(value: string): string {
  const normalized = value.split(/\s+/).filter(Boolean).join(" ");
  return [...normalized].length <= 180
    ? normalized
    : `${[...normalized].slice(0, 180).join("")}…`;
}

function boundedMultiline(value: string): string {
  const lines = value.trim().split("\n");
  let output = "";
  let characters = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (index >= 24) return `${output}\n…`;
    if (index) output += "\n";
    for (const character of lines[index]!) {
      if (characters >= 4_000) return `${output}…`;
      output += character;
      characters += 1;
    }
  }
  return output;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
