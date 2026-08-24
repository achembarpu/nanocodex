import type { AgentEvent } from "nanocodex";
import { isClientNetworkFailure } from "./clientFailure.ts";
import {
  applyAgentEvents,
  initialTerminalState,
  queuePrompt,
  queueSteer,
  steerAdmitted,
  steerFailed,
  turnFinished,
  type TerminalEntry,
  type TerminalState,
} from "./agentTranscript.ts";

const CLEAR_SCREEN = "\x1b[3J\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const MAX_ENTRY_CHARACTERS = 8_000;
const DEFAULT_MAX_PROMPT_HISTORY = 200;

export type TerminalHost = Readonly<{
  write(data: string | Uint8Array, options?: { preserveScroll?: boolean }): void | Promise<void>;
  onData(listener: (data: string, receivedAt: number) => void): () => void;
  onResize(listener: (size: { cols: number; rows: number }) => void): () => void;
  onScroll?(listener: (position: { baseY: number; viewportY: number }) => void): () => void;
  isVisible?(): boolean;
  onVisibilityChange?(listener: () => void): () => void;
  readonly cols: number;
  readonly rows: number;
}>;

export type AgentTerminalEvent = Readonly<{
  type: string;
  timestamp: number;
  [key: string]: unknown;
}>;

export type AgentTerminalInputMode = "xterm" | "composer";

export type AgentTerminal = Readonly<{
  ready: Promise<void>;
  submit(input: string, options?: {
    intent?: "queue" | "steer";
    submittedAt?: number;
  }): Promise<TerminalTurn | undefined>;
  cancel(): Promise<void>;
  render(): void;
  resize(): void;
  setInputMode(mode: AgentTerminalInputMode): void;
  dispose(): void;
}>;

export type TerminalTurn = Readonly<{
  steer(options: { input: string }): Promise<unknown>;
  cancel(): Promise<unknown>;
  result(): Promise<Readonly<{ finalMessage: string; dispose(): void }>>;
  dispose(): void;
}>;

export type TerminalAgent = Readonly<{
  sessionId: string;
  turn: Readonly<{ prompt(options: { input: string }): TerminalTurn }>;
  events: Readonly<{
    watch(): Readonly<{
      onEvent(listener: (event: AgentEvent) => void): () => void;
      onHistory?(listener: (events: readonly AgentEvent[]) => void): () => void;
      loadOlder?(): Promise<boolean>;
      off(): void;
    }>;
  }>;
}>;

type ActiveTurn = {
  timing: PromptTiming;
  turn: TerminalTurn;
};

type PromptTiming = {
  id: number;
  firstOutputReported: boolean;
  runStartedAt?: number;
  submittedAt: number;
};

/** App-local terminal presentation used only by the website demo. */
export function createAgentTerminal(options: {
  agent: TerminalAgent;
  terminal: TerminalHost;
  inputMode?: AgentTerminalInputMode;
  maxEntries?: number;
  maxHistory?: number;
  onEvent?(event: AgentTerminalEvent): void;
}): AgentTerminal {
  const { agent, terminal } = options;
  validateTerminal(terminal);

  let state = initialTerminalState();
  let input = "";
  let cursor = 0;
  let historyIndex: number | undefined;
  let inputMode = options.inputMode ?? "xterm";
  let disposed = false;
  let renderScheduled = false;
  let projectionDirty = true;
  let preserveScroll = false;
  let projectedHistoryEntryIds = new Set<string>();
  let cancelScheduledRender: (() => void) | undefined;
  let nextPromptId = 1;
  const history: string[] = [];
  const activeTurns = new Set<ActiveTurn>();
  const pendingRootPrompts: PromptTiming[] = [];
  let currentRootPrompt: PromptTiming | undefined;
  const maxEntries = positiveInteger(options.maxEntries, 200);
  const maxHistory = positiveInteger(options.maxHistory, DEFAULT_MAX_PROMPT_HISTORY);
  const surface = terminalSurface(terminal);
  const watcher = agent.events.watch();
  const listeners: Array<() => void> = [];
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const emit = (type: string, detail: Record<string, unknown> = {}) => {
    try {
      options.onEvent?.({ type, timestamp: performanceNow(), ...detail });
    } catch {
      // Host diagnostics must never break the terminal lifecycle.
    }
  };

  const writeFrame = () => {
    renderScheduled = false;
    cancelScheduledRender = undefined;
    if (disposed || !projectionDirty || !surface.isVisible()) return;
    projectionDirty = false;
    const frame = renderTerminal({
      state,
      input,
      cursor,
      cols: terminal.cols,
      rows: terminal.rows,
      inputMode,
    });
    try {
      Promise.resolve(terminal.write(frame, { preserveScroll })).then(resolveReady, (error) => {
        emit("terminal.write_error", { error });
        rejectReady(error);
      });
    } catch (error) {
      emit("terminal.write_error", { error });
      rejectReady(error);
    }
    preserveScroll = false;
  };

  const render = () => {
    if (disposed) return;
    projectionDirty = true;
    if (renderScheduled || !surface.isVisible()) return;
    renderScheduled = true;
    cancelScheduledRender = scheduleFrame(writeFrame);
  };

  const visibilityChanged = () => {
    if (disposed) return;
    if (!surface.isVisible()) {
      cancelScheduledRender?.();
      cancelScheduledRender = undefined;
      renderScheduled = false;
      return;
    }
    if (projectionDirty) render();
  };

  listeners.push(watcher.onEvent((event) => {
    if (disposed || event.request_id !== agent.sessionId) return;
    observeRootTurnEvent(event);
    const wasRunning = state.running;
    state = boundedTerminalState(applyAgentEvents(state, [event]), maxEntries);
    if (state.running !== wasRunning) {
      emit("terminal.running_changed", { running: state.running });
    }
    render();
  }));
  if (watcher.onHistory) {
    listeners.push(watcher.onHistory((events) => {
      if (disposed) return;
      const historical = applyAgentEvents(initialTerminalState(), events);
      const historicalIds = new Set(historical.entries.map((entry) => entry.id));
      const localEntries = state.entries.filter((entry) =>
        !projectedHistoryEntryIds.has(entry.id) && !historicalIds.has(entry.id)
      );
      projectedHistoryEntryIds = historicalIds;
      state = { ...state, entries: [...historical.entries, ...localEntries] };
      preserveScroll = true;
      render();
    }));
  }
  if (terminal.onScroll && watcher.loadOlder) {
    // The blank xterm viewport reports position zero during attachment. Arm
    // only after a rendered transcript has placed the viewport away from the
    // top, so startup cannot masquerade as an upward user scroll.
    let loadArmed = false;
    let loadingOlder = false;
    listeners.push(terminal.onScroll(({ viewportY }) => {
      const nextNearTop = viewportY <= Math.max(8, terminal.rows);
      if (!nextNearTop) {
        if (!loadingOlder) loadArmed = true;
        return;
      }
      if (!loadArmed || loadingOlder) return;
      loadArmed = false;
      loadingOlder = true;
      void watcher.loadOlder?.().finally(() => { loadingOlder = false; });
    }));
  }

  async function submit(
    value: string,
    submitOptions: { intent?: "queue" | "steer"; submittedAt?: number } = {},
  ): Promise<TerminalTurn | undefined> {
    const submittedAt = finiteTimestamp(submitOptions.submittedAt) ?? performanceNow();
    const submitted = String(value);
    const prompt = submitted.trim();
    if (!prompt || disposed) return undefined;
    retainPromptHistory(history, submitted, maxHistory);
    if (prompt === "/clear") {
      state = boundedTerminalState({ ...state, entries: [] }, maxEntries);
      render();
      return undefined;
    }
    if (prompt === "/cancel") {
      await cancel();
      return undefined;
    }
    if (prompt === "/exit") {
      dispose();
      return undefined;
    }
    if (prompt === "/help") {
      appendLocal("Enter sends · Shift+Enter adds a line · /cancel · /clear · /exit");
      return undefined;
    }

    const id = nextPromptId++;
    const current = latestActiveTurn();
    if (submitOptions.intent === "steer" && current) {
      state = boundedTerminalState(queueSteer(state, id, prompt), maxEntries);
      render();
      try {
        await current.turn.steer({ input: prompt });
        state = boundedTerminalState(steerAdmitted(state, id), maxEntries);
        emit("prompt.steered", { id });
      } catch (error) {
        state = boundedTerminalState(
          steerFailed(state, id, terminalErrorMessage(error)),
          maxEntries,
        );
        emit("prompt.steer_error", { error, id });
      }
      render();
      return current.turn;
    }

    let turn: TerminalTurn;
    try {
      turn = agent.turn.prompt({ input: prompt });
    } catch (error) {
      appendTerminalError(terminalErrorMessage(error));
      emit("prompt.rejected", { error, id });
      return undefined;
    }
    state = boundedTerminalState(queuePrompt(state, id, prompt), maxEntries);
    const timing: PromptTiming = {
      id,
      firstOutputReported: false,
      submittedAt,
    };
    const record: ActiveTurn = { timing, turn };
    activeTurns.add(record);
    pendingRootPrompts.push(timing);
    emit("prompt.accepted", { id, input: prompt, sessionId: agent.sessionId, submittedAt });
    render();
    void finishTurn(record);
    return turn;
  }

  async function finishTurn(record: ActiveTurn) {
    let result: Awaited<ReturnType<TerminalTurn["result"]>> | undefined;
    try {
      result = await record.turn.result();
      const completed = { finalMessage: result.finalMessage };
      state = boundedTerminalState(
        turnFinished(state, undefined, completed.finalMessage),
        maxEntries,
      );
      emit("prompt.completed", { id: record.timing.id, ...completed });
    } catch (error) {
      state = boundedTerminalState(
        turnFinished(state, terminalErrorMessage(error)),
        maxEntries,
      );
      emit("prompt.failed", { error, id: record.timing.id });
    } finally {
      if (result) {
        try {
          result.dispose();
        } catch (error) {
          emit("terminal.cleanup_error", { error });
        }
      }
      activeTurns.delete(record);
      const pendingIndex = pendingRootPrompts.indexOf(record.timing);
      if (pendingIndex >= 0) pendingRootPrompts.splice(pendingIndex, 1);
      try {
        record.turn.dispose();
      } catch (error) {
        emit("terminal.cleanup_error", { error });
      }
      render();
    }
  }

  async function cancel() {
    const current = latestActiveTurn();
    if (!current) {
      appendLocal("No active turn.");
      return;
    }
    try {
      await current.turn.cancel();
      emit("prompt.cancelled");
    } catch (error) {
      appendTerminalError(terminalErrorMessage(error));
      emit("prompt.cancel_error", { error });
    }
  }

  function latestActiveTurn(): ActiveTurn | undefined {
    let latest: ActiveTurn | undefined;
    for (const record of activeTurns) latest = record;
    return latest;
  }

  function observeRootTurnEvent(event: {
    payload?: Record<string, unknown>;
    seq?: number;
    type: string;
  }) {
    if (event.type === "run.started") {
      currentRootPrompt = pendingRootPrompts.shift();
      if (currentRootPrompt) currentRootPrompt.runStartedAt = performanceNow();
      return;
    }
    if (event.type === "run.completed" || event.type === "run.failed") {
      currentRootPrompt = undefined;
      return;
    }
    if (event.type !== "assistant.delta" && event.type !== "reasoning.summary.delta") return;
    if (typeof event.payload?.text !== "string" || event.payload.text.length === 0) return;
    const current = currentRootPrompt;
    if (!current || current.firstOutputReported || current.runStartedAt === undefined) return;
    current.firstOutputReported = true;
    emit("prompt.first_output", {
      eventSeq: event.seq,
      id: current.id,
      runStartedAt: current.runStartedAt,
      sessionId: agent.sessionId,
      submittedAt: current.submittedAt,
    });
  }

  const commitInput = (submittedAt: number) => {
    const value = input;
    input = "";
    cursor = 0;
    historyIndex = undefined;
    if (value.trim()) void submit(value, { submittedAt });
    else render();
  };

  const onData = (data: string, receivedAt: number) => {
    if (disposed || inputMode !== "xterm" || typeof data !== "string") return;
    if (data === "\x1b[13;2u") {
      insert("\n");
      return;
    }
    if (data === "\x1b[A") {
      moveHistory(-1);
      return;
    }
    if (data === "\x1b[B") {
      moveHistory(1);
      return;
    }
    if (data === "\x1b[D") {
      cursor = Math.max(0, cursor - 1);
      render();
      return;
    }
    if (data === "\x1b[C") {
      cursor = Math.min(input.length, cursor + 1);
      render();
      return;
    }
    if (data === "\x1b[3~") {
      if (cursor < input.length) input = input.slice(0, cursor) + input.slice(cursor + 1);
      render();
      return;
    }
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
      insert(data.slice(6, -6).replace(/\r\n?/g, "\n"));
      return;
    }
    for (const character of data) {
      if (character === "\r" || character === "\n") {
        commitInput(receivedAt);
      } else if (character === "\x03") {
        if (activeTurns.size > 0) void cancel();
        else {
          input = "";
          cursor = 0;
          render();
        }
      } else if (character === "\x0c") {
        render();
      } else if (character === "\x7f" || character === "\b") {
        if (cursor > 0) {
          input = input.slice(0, cursor - 1) + input.slice(cursor);
          cursor -= 1;
        }
        render();
      } else if (character >= " " && character !== "\x7f") {
        insert(character);
      }
    }
  };

  function insert(value: string) {
    input = input.slice(0, cursor) + value + input.slice(cursor);
    cursor += value.length;
    render();
  }

  function moveHistory(delta: number) {
    if (!history.length) return;
    const next = historyIndex === undefined
      ? delta < 0 ? history.length - 1 : history.length
      : Math.max(0, Math.min(history.length, historyIndex + delta));
    historyIndex = next === history.length ? undefined : next;
    input = historyIndex === undefined ? "" : history[historyIndex]!;
    cursor = input.length;
    render();
  }

  function appendLocal(text: string) {
    const syntheticId = state.syntheticId + 1;
    state = boundedTerminalState({
      ...state,
      syntheticId,
      entries: [...state.entries, {
        id: `terminal-${syntheticId}`,
        kind: "assistant",
        text,
        streaming: false,
      }],
    }, maxEntries);
    render();
  }

  function appendTerminalError(text: string) {
    const syntheticId = state.syntheticId + 1;
    state = boundedTerminalState({
      ...state,
      syntheticId,
      entries: [
        ...state.entries,
        { id: `terminal-error-${syntheticId}`, kind: "error", text },
      ],
    }, maxEntries);
    render();
  }

  function resize() {
    emit("terminal.resize", { cols: terminal.cols, rows: terminal.rows });
    render();
  }

  function setInputMode(next: AgentTerminalInputMode) {
    if (inputMode === next) return;
    inputMode = next;
    if (next === "composer") {
      input = "";
      cursor = 0;
      historyIndex = undefined;
    }
    render();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelScheduledRender?.();
    cancelScheduledRender = undefined;
    renderScheduled = false;
    history.length = 0;
    pendingRootPrompts.length = 0;
    currentRootPrompt = undefined;
    watcher.off();
    for (const release of listeners.splice(0)) {
      try {
        release();
      } catch (error) {
        emit("terminal.cleanup_error", { error });
      }
    }
    try {
      if (surface.isVisible() && inputMode === "xterm") {
        void Promise.resolve(terminal.write(SHOW_CURSOR)).catch((error) => {
          emit("terminal.cleanup_error", { error });
        });
      }
    } catch (error) {
      emit("terminal.cleanup_error", { error });
    }
    resolveReady();
    emit("terminal.detached");
  }

  listeners.push(surface.onVisibilityChange(visibilityChanged));
  listeners.push(terminal.onData(onData));
  listeners.push(terminal.onResize(resize));
  emit("terminal.attached", { cols: terminal.cols, rows: terminal.rows });
  render();

  return Object.freeze({ ready, submit, cancel, render, resize, setInputMode, dispose });
}

export function renderTerminal({
  state,
  input = "",
  cursor = input.length,
  cols = 80,
  rows = 24,
  inputMode = "xterm",
}: {
  state: TerminalState;
  input?: string;
  cursor?: number;
  cols?: number;
  rows?: number;
  inputMode?: AgentTerminalInputMode;
}): string {
  const content = [`${BOLD}nanocodex${RESET}`, renderTranscript(state.entries, cols)]
    .filter(Boolean)
    .join("\r\n\r\n");
  if (inputMode === "composer") return `${CLEAR_SCREEN}${HIDE_CURSOR}${content}`;
  const safeCursor = Math.max(0, Math.min(input.length, cursor));
  const before = terminalText(input.slice(0, safeCursor));
  const at = terminalText(input.slice(safeCursor, safeCursor + 1) || " ");
  const after = terminalText(input.slice(safeCursor + 1));
  const footer = [
    `${DIM}│${RESET} ${before}\x1b[7m${at}${RESET}${after}`,
    `${DIM}  ${footerHint(cols)}${RESET}`,
  ].join("\r\n");
  const gap = Math.max(
    1,
    positiveInteger(rows, 24) - renderedRows(content, cols) - renderedRows(footer, cols) - 1,
  );
  return `${CLEAR_SCREEN}${HIDE_CURSOR}${content}${"\r\n".repeat(gap)}${footer}`;
}

function renderTranscript(entries: TerminalEntry[], cols: number): string {
  return entries.reduce((output, entry, index) => {
    if (index > 0) {
      output += entries[index - 1]?.kind === "tool" && entry.kind === "tool"
        ? "\r\n"
        : "\r\n\r\n";
    }
    return output + renderEntry(entry, cols);
  }, "");
}

function renderEntry(entry: TerminalEntry, cols: number): string {
  switch (entry.kind) {
    case "user":
      return renderUserEntry(entry.text, cols);
    case "assistant":
      return indentText(boundedText(entry.text));
    case "reasoning":
      return `${DIM}  thinking${entry.streaming ? "…" : ""}\r\n${indentText(boundedText(entry.text))}${RESET}`;
    case "error":
      return `${RED}!${RESET} ${boundedText(entry.text)}`;
    case "plan":
      return `${DIM}${entry.update.plan.map((step) =>
        `  ${step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "·"} ${terminalText(step.step)}`
      ).join("\r\n")}${RESET}`;
    case "tool": {
      const result = entry.tool.result
        ? `\r\n${indentText(boundedText(entry.tool.result))}`
        : "";
      return `${DIM}  ${entry.tool.status === "running" ? "→" : entry.tool.status === "completed" ? "✓" : "!"} ${terminalText(entry.tool.name)}${result}${RESET}`;
    }
  }
}

function renderUserEntry(value: string, cols: number): string {
  const text = terminalText(value);
  const bounded = text.length > MAX_ENTRY_CHARACTERS
    ? `${text.slice(0, MAX_ENTRY_CHARACTERS)}\r\n… input truncated`
    : text;
  return bounded
    .split("\r\n")
    .flatMap((line) => wrapLine(line, Math.max(8, positiveInteger(cols, 80) - 2)))
    .map((line) => `${DIM}│${RESET} ${BOLD}${line}${RESET}`)
    .join("\r\n");
}

function wrapLine(line: string, width: number): string[] {
  const characters = [...line];
  if (characters.length <= width) return [line];
  const rows: string[] = [];
  let cursor = 0;
  while (characters.length - cursor > width) {
    let breakAt = -1;
    for (let index = 0; index <= width; index += 1) {
      if (characters[cursor + index] === " ") breakAt = index;
    }
    const take = breakAt > 0 ? breakAt : width;
    rows.push(characters.slice(cursor, cursor + take).join(""));
    cursor += take + (breakAt > 0 ? 1 : 0);
  }
  rows.push(characters.slice(cursor).join(""));
  return rows;
}

function indentText(value: string): string {
  return String(value).split("\r\n").map((line) => `  ${line}`).join("\r\n");
}

function boundedText(value: string): string {
  const text = terminalText(value);
  return text.length > MAX_ENTRY_CHARACTERS
    ? `${text.slice(0, MAX_ENTRY_CHARACTERS)}\r\n${DIM}… output truncated${RESET}`
    : text;
}

function terminalText(value: string): string {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�")
    .replace(/\x1b/g, "�")
    .replace(/\n/g, "\r\n");
}

function renderedRows(value: string, cols: number): number {
  const width = positiveInteger(cols, 80);
  return String(value).split("\r\n").reduce((total, line) => {
    const visible = line.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
    return total + Math.max(1, Math.ceil([...visible].length / width));
  }, 0);
}

function footerHint(cols: number): string {
  const width = positiveInteger(cols, 80);
  if (width >= 54) return "enter send · shift+enter newline · /help";
  if (width >= 34) return "enter send · shift+enter newline";
  return "enter send";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function finiteTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function retainPromptHistory(history: string[], submitted: string, maxHistory: number) {
  const retained = submitted.length > MAX_ENTRY_CHARACTERS
    ? submitted.slice(0, MAX_ENTRY_CHARACTERS)
    : submitted;
  if (history.at(-1) === retained) return;
  history.push(retained);
  if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
}

function boundedTerminalState(state: TerminalState, maxEntries: number): TerminalState {
  const retained = state.entries.length > maxEntries
    ? state.entries.slice(-maxEntries)
    : state.entries;
  let ownsEntries = retained !== state.entries;
  let entries = retained;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!("text" in entry) || entry.text.length <= MAX_ENTRY_CHARACTERS + 1) continue;
    if (!ownsEntries) {
      entries = entries.slice();
      ownsEntries = true;
    }
    entries[index] = { ...entry, text: entry.text.slice(0, MAX_ENTRY_CHARACTERS + 1) };
  }
  return ownsEntries ? { ...state, entries } : state;
}

function scheduleFrame(callback: () => void): () => void {
  let active = true;
  if (typeof globalThis.requestAnimationFrame === "function") {
    try {
      const frame = globalThis.requestAnimationFrame(() => {
        if (!active) return;
        active = false;
        callback();
      });
      return () => {
        if (!active) return;
        active = false;
        try {
          globalThis.cancelAnimationFrame?.(frame);
        } catch {
          // The active guard still cancels the callback for partial DOM shims.
        }
      };
    } catch {
      // Test and non-window DOM shims fall through to the microtask scheduler.
    }
  }
  queueMicrotask(() => {
    if (!active) return;
    active = false;
    callback();
  });
  return () => { active = false; };
}

function terminalSurface(terminal: TerminalHost): {
  isVisible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
} {
  const browser = browserTerminalSurface();
  const isVisible = () => {
    try {
      return terminal.isVisible ? terminal.isVisible() : browser.isVisible();
    } catch {
      return false;
    }
  };
  return {
    isVisible,
    onVisibilityChange(listener) {
      return terminal.onVisibilityChange
        ? terminal.onVisibilityChange(listener)
        : browser.onVisibilityChange(listener);
    },
  };
}

function browserTerminalSurface(): {
  isVisible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
} {
  const document = globalThis.document;
  if (!document) {
    return { isVisible: () => true, onVisibilityChange: () => () => {} };
  }
  let element = document.querySelector<HTMLElement>(".agent-xterm");
  let owner = element?.closest<HTMLElement>(".nanocodex-demo");
  const isVisible = () => {
    if (!element?.isConnected) {
      element = document.querySelector<HTMLElement>(".agent-xterm");
      owner = element?.closest<HTMLElement>(".nanocodex-demo");
    }
    return document.visibilityState !== "hidden"
      && element?.isConnected === true
      && owner?.classList.contains("is-hidden") !== true
      && element.closest("[hidden], [aria-hidden=\"true\"]") === null;
  };
  return {
    isVisible,
    onVisibilityChange(listener) {
      let visible = isVisible();
      const notify = () => {
        const next = isVisible();
        if (next === visible) return;
        visible = next;
        listener();
      };
      document.addEventListener("visibilitychange", notify);
      const observer = typeof globalThis.MutationObserver === "function"
        ? new globalThis.MutationObserver(notify)
        : undefined;
      const modeObserver = typeof globalThis.MutationObserver === "function"
        ? new globalThis.MutationObserver(notify)
        : undefined;
      observer?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["hidden", "aria-hidden"],
        subtree: true,
      });
      if (owner) {
        modeObserver?.observe(owner, { attributes: true, attributeFilter: ["class"] });
      }
      return () => {
        document.removeEventListener("visibilitychange", notify);
        observer?.disconnect();
        modeObserver?.disconnect();
      };
    },
  };
}

function validateTerminal(terminal: TerminalHost): void {
  if (!terminal || typeof terminal.write !== "function"
    || typeof terminal.onData !== "function" || typeof terminal.onResize !== "function"
    || !Number.isFinite(terminal.cols) || !Number.isFinite(terminal.rows)) {
    throw new TypeError("terminal must provide write, onData, onResize, cols, and rows");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminalErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (isClientNetworkFailure(error)) {
    return "The agent connection was interrupted. Check your network and try again.";
  }
  return /Responses WebSocket handshake failed|WebSocket connection failed/.test(message)
    ? "Could not connect to the agent. Try again."
    : message;
}

function performanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
