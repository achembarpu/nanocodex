import {
  applyAgentEvents,
  initialTerminalState,
  queuePrompt,
  queueSteer,
  steerAdmitted,
  steerFailed,
  turnFinished,
} from "nanocodex-tui";

const CLEAR_SCREEN = "\x1b[3J\x1b[2J\x1b[H";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const MAX_ENTRY_CHARACTERS = 8_000;

/**
 * Connects one retained Nanocodex Agent to a terminal-shaped host.
 *
 * The adapter owns presentation and input only. The caller keeps ownership of
 * the Agent, its tools, transport, persistence, and shutdown policy.
 */
export function createAgentTerminal(options) {
  const { agent, terminal } = options ?? {};
  if (!agent?.turn?.prompt || !agent?.events?.watch) {
    throw new TypeError("createAgentTerminal requires a Nanocodex Agent");
  }
  validateTerminal(terminal);

  let state = initialTerminalState();
  let input = "";
  let cursor = 0;
  let historyIndex;
  let disposed = false;
  let renderScheduled = false;
  let nextPromptId = 1;
  const history = [];
  const activeTurns = [];
  const maxEntries = positiveInteger(options.maxEntries, 200);
  const watcher = agent.events.watch();
  const listeners = [];
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const emit = (type, detail = {}) => {
    try {
      options.onEvent?.({ type, timestamp: performanceNow(), ...detail });
    } catch {
      // Host diagnostics must never break the terminal lifecycle.
    }
  };

  const writeFrame = () => {
    if (disposed) return;
    renderScheduled = false;
    const frame = renderTerminal({
      state: state.entries.length > maxEntries
        ? { ...state, entries: state.entries.slice(-maxEntries) }
        : state,
      input,
      cursor,
      cols: terminal.cols,
      rows: terminal.rows,
    });
    try {
      Promise.resolve(terminal.write(frame)).then(resolveReady, (error) => {
        emit("terminal.write_error", { error });
        rejectReady(error);
      });
    } catch (error) {
      emit("terminal.write_error", { error });
      rejectReady(error);
    }
  };

  const render = () => {
    if (disposed || renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(writeFrame);
  };

  const onAgentEvent = (event) => {
    if (disposed) return;
    state = applyAgentEvents(state, [event]);
    render();
  };
  listeners.push(watcher.onEvent(onAgentEvent));

  async function submit(value, submitOptions = {}) {
    const prompt = String(value).trim();
    if (!prompt || disposed) return undefined;
    if (prompt === "/clear") {
      state = { ...state, entries: [] };
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
    const current = activeTurns.findLast((record) => !record.settled);
    if (submitOptions.intent === "steer" && current) {
      state = queueSteer(state, id, prompt);
      render();
      try {
        await current.turn.steer({ input: prompt });
        state = steerAdmitted(state, id);
        emit("prompt.steered", { id });
      } catch (error) {
        state = steerFailed(state, id, errorMessage(error));
        emit("prompt.steer_error", { error, id });
      }
      render();
      return current.turn;
    }

    let turn;
    try {
      turn = agent.turn.prompt({ input: prompt });
    } catch (error) {
      appendError(errorMessage(error));
      emit("prompt.rejected", { error, id });
      return undefined;
    }
    state = queuePrompt(state, id, prompt);
    const record = { turn, settled: false };
    activeTurns.push(record);
    emit("prompt.accepted", { id });
    render();
    void turn.result().then((result) => {
      state = turnFinished(state, undefined, result.finalMessage);
      emit("prompt.completed", { id, result });
    }, (error) => {
      state = turnFinished(state, errorMessage(error));
      emit("prompt.failed", { error, id });
    }).finally(() => {
      record.settled = true;
      turn.dispose();
      render();
    });
    return turn;
  }

  async function cancel() {
    const current = activeTurns.findLast((record) => !record.settled);
    if (!current) {
      appendLocal("No active turn.");
      return;
    }
    try {
      await current.turn.cancel();
      emit("prompt.cancelled");
    } catch (error) {
      appendError(errorMessage(error));
      emit("prompt.cancel_error", { error });
    }
  }

  const commitInput = () => {
    const value = input;
    input = "";
    cursor = 0;
    historyIndex = undefined;
    if (value.trim()) {
      if (history.at(-1) !== value) history.push(value);
      void submit(value);
    } else {
      render();
    }
  };

  const onData = (data) => {
    if (disposed || typeof data !== "string") return;
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
        commitInput();
      } else if (character === "\x03") {
        if (activeTurns.some((record) => !record.settled)) void cancel();
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

  function insert(value) {
    input = input.slice(0, cursor) + value + input.slice(cursor);
    cursor += value.length;
    render();
  }

  function moveHistory(delta) {
    if (!history.length) return;
    const next = historyIndex === undefined
      ? delta < 0 ? history.length - 1 : history.length
      : Math.max(0, Math.min(history.length, historyIndex + delta));
    historyIndex = next === history.length ? undefined : next;
    input = historyIndex === undefined ? "" : history[historyIndex];
    cursor = input.length;
    render();
  }

  function appendLocal(text) {
    const syntheticId = state.syntheticId + 1;
    state = {
      ...state,
      syntheticId,
      entries: [...state.entries, {
        id: `terminal-${syntheticId}`,
        kind: "assistant",
        text,
        streaming: false,
      }],
    };
    render();
  }

  function appendError(text) {
    const syntheticId = state.syntheticId + 1;
    state = {
      ...state,
      syntheticId,
      entries: [...state.entries, { id: `terminal-error-${syntheticId}`, kind: "error", text }],
    };
    render();
  }

  function resize() {
    emit("terminal.resize", { cols: terminal.cols, rows: terminal.rows });
    render();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    watcher.off();
    for (const release of listeners.splice(0)) {
      try { release?.(); } catch (error) { emit("terminal.cleanup_error", { error }); }
    }
    resolveReady();
    emit("terminal.detached");
  }

  listeners.push(terminal.onData(onData));
  listeners.push(terminal.onResize(resize));
  emit("terminal.attached", { cols: terminal.cols, rows: terminal.rows });
  writeFrame();

  return Object.freeze({
    ready,
    submit,
    cancel,
    render,
    resize,
    dispose,
  });
}

export function renderTerminal({ state, input = "", cursor = input.length, cols = 80 }) {
  const lines = [`${BOLD}nanocodex${RESET}`];
  if (!state.entries.length) lines.push(`${DIM}Ask the agent anything.${RESET}`);
  for (const entry of state.entries) lines.push(renderEntry(entry));
  const status = state.running
    ? `${CYAN}${state.status || "Running"}${RESET}`
    : `${DIM}${state.status || "Ready"}${RESET}`;
  lines.push(status);
  const safeInput = terminalText(input);
  const safeCursor = Math.max(0, Math.min(input.length, cursor));
  const before = terminalText(input.slice(0, safeCursor));
  const at = terminalText(input.slice(safeCursor, safeCursor + 1) || " ");
  const after = terminalText(input.slice(safeCursor + 1));
  lines.push(`${BOLD}>${RESET} ${before}\x1b[7m${at}${RESET}${after}`);
  lines.push(`${DIM}${rule(cols)}  Enter send · Shift+Enter newline · /help${RESET}`);
  return `${CLEAR_SCREEN}${lines.join("\r\n\r\n")}\r\n`;
}

export function encodeXtermKeyEvent(event) {
  if (event.type !== "keydown" || event.altKey || event.ctrlKey) return null;
  if (event.key === "Enter" && event.shiftKey && !event.metaKey) return "\x1b[13;2u";
  return null;
}

export function xtermAdapter(term) {
  if (!term?.write || !term?.onData || !term?.onResize) {
    throw new TypeError("xtermAdapter requires an xterm.js Terminal");
  }
  let keyDataHandler;
  term.attachCustomKeyEventHandler?.((event) => {
    const data = encodeXtermKeyEvent(event);
    if (data === null || !keyDataHandler) return true;
    keyDataHandler(data);
    return false;
  });
  return {
    write: (data) => term.write(typeof data === "string" ? data : new TextDecoder().decode(data)),
    onData(callback) {
      const data = term.onData(callback);
      keyDataHandler = callback;
      return () => {
        data.dispose();
        if (keyDataHandler === callback) keyDataHandler = undefined;
      };
    },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    onResize(callback) {
      const disposable = term.onResize(({ cols, rows }) => callback({ cols, rows }));
      return () => disposable.dispose();
    },
  };
}

export function wtermAdapter(term) {
  if (!term?.write || typeof term.cols !== "number" || typeof term.rows !== "number") {
    throw new TypeError("wtermAdapter requires a WTerm instance");
  }
  const dataListeners = new Set();
  const resizeListeners = new Set();
  const previousData = term.onData;
  const previousResize = term.onResize;
  let dataAttached = false;
  let resizeAttached = false;
  let restored = false;
  const restore = () => {
    if (restored || !dataAttached || !resizeAttached
      || dataListeners.size || resizeListeners.size) return;
    restored = true;
    term.onData = previousData;
    term.onResize = previousResize;
  };
  term.onData = (data) => {
    previousData?.(data);
    for (const listener of dataListeners) listener(data);
  };
  term.onResize = (cols, rows) => {
    previousResize?.(cols, rows);
    for (const listener of resizeListeners) listener({ cols, rows });
  };
  return {
    write: (data) => term.write(data),
    onData(callback) {
      dataAttached = true;
      dataListeners.add(callback);
      return () => {
        dataListeners.delete(callback);
        restore();
      };
    },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    onResize(callback) {
      resizeAttached = true;
      resizeListeners.add(callback);
      return () => {
        resizeListeners.delete(callback);
        restore();
      };
    },
  };
}

function renderEntry(entry) {
  switch (entry.kind) {
    case "user":
      return `${BOLD}you${RESET}\r\n${boundedText(entry.text)}`;
    case "assistant":
      return `${BOLD}nanocodex${entry.streaming ? ` ${CYAN}· live${RESET}` : ""}${RESET}\r\n${boundedText(entry.text)}`;
    case "reasoning":
      return `${DIM}thinking${entry.streaming ? " · live" : ""}\r\n${boundedText(entry.text)}${RESET}`;
    case "error":
      return `${RED}error${RESET}\r\n${boundedText(entry.text)}`;
    case "plan":
      return `${DIM}plan\r\n${entry.update.plan.map((step) => `${step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "·"} ${terminalText(step.step)}`).join("\r\n")}${RESET}`;
    case "tool": {
      const result = entry.tool.result ? `\r\n${boundedText(entry.tool.result)}` : "";
      return `${DIM}${entry.tool.status === "running" ? "→" : entry.tool.status === "completed" ? "✓" : "!"} ${terminalText(entry.tool.name)}${result}${RESET}`;
    }
  }
}

function boundedText(value) {
  const text = terminalText(value);
  return text.length > MAX_ENTRY_CHARACTERS
    ? `${text.slice(0, MAX_ENTRY_CHARACTERS)}\r\n${DIM}… output truncated${RESET}`
    : text;
}

function terminalText(value) {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�")
    .replace(/\x1b/g, "�")
    .replace(/\n/g, "\r\n");
}

function rule(cols) {
  return "─".repeat(Math.max(8, Math.min(48, positiveInteger(cols, 80) - 2)));
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validateTerminal(terminal) {
  if (!terminal || typeof terminal.write !== "function"
    || typeof terminal.onData !== "function" || typeof terminal.onResize !== "function"
    || !Number.isFinite(terminal.cols) || !Number.isFinite(terminal.rows)) {
    throw new TypeError("terminal must provide write, onData, onResize, cols, and rows");
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function performanceNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
