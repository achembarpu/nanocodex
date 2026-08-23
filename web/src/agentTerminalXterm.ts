type TerminalSize = Readonly<{ cols: number; rows: number }>;
const MAX_BUFFERED_INPUT = 64 * 1024;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

type XtermLike = {
  write(data: string, callback?: () => void): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: TerminalSize) => void): { dispose(): void };
  onScroll?(listener: (viewportY: number) => void): { dispose(): void };
  scrollToLine?(line: number): void;
  readonly buffer?: { active: { baseY: number; viewportY: number } };
  attachCustomKeyEventHandler?(listener: (event: KeyboardEvent) => boolean): void;
  readonly cols: number;
  readonly rows: number;
};

/** Translate the one modified key sequence the website terminal consumes. */
export function encodeXtermKeyEvent(event: KeyboardEvent): string | null {
  if (event.type !== "keydown" || event.altKey || event.ctrlKey) return null;
  if (event.key === "Enter" && event.shiftKey && !event.metaKey) return "\x1b[13;2u";
  return null;
}

/** Whether the native touch composer should submit after IME handling. */
export function isTerminalSubmitKeyEvent(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">,
  composing = false,
): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
    && !composing;
}

/** App-local xterm subscription adapter for the website Agent surface. */
export function xtermAdapter(term: XtermLike, now: () => number = performanceNow) {
  if (!term?.write || !term?.onData || !term?.onResize) {
    throw new TypeError("xtermAdapter requires an xterm.js Terminal");
  }
  let keyDataHandler: ((data: string) => void) | undefined;
  term.attachCustomKeyEventHandler?.((event) => {
    const data = encodeXtermKeyEvent(event);
    if (data === null || !keyDataHandler) return true;
    keyDataHandler(data);
    return false;
  });
  return {
    write(data: string | Uint8Array, options: { preserveScroll?: boolean } = {}) {
      const bottomOffset = options.preserveScroll && term.buffer
        ? term.buffer.active.baseY - term.buffer.active.viewportY
        : undefined;
      return new Promise<void>((resolve) => term.write(
        typeof data === "string" ? data : new TextDecoder().decode(data),
        () => {
          if (bottomOffset !== undefined && term.buffer && term.scrollToLine) {
            term.scrollToLine(Math.max(0, term.buffer.active.baseY - bottomOffset));
          }
          resolve();
        },
      ));
    },
    onData(callback: (data: string, receivedAt: number) => void) {
      const receive = (data: string) => callback(data, now());
      const data = term.onData(receive);
      keyDataHandler = receive;
      return () => {
        data.dispose();
        if (keyDataHandler === receive) keyDataHandler = undefined;
      };
    },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    onResize(callback: (size: TerminalSize) => void) {
      const disposable = term.onResize(({ cols, rows }) => callback({ cols, rows }));
      return () => disposable.dispose();
    },
    onScroll(callback: (position: { baseY: number; viewportY: number }) => void) {
      if (!term.onScroll || !term.buffer) return () => {};
      const disposable = term.onScroll((viewportY) => callback({
        baseY: term.buffer!.active.baseY,
        viewportY,
      }));
      return () => disposable.dispose();
    },
  };
}

/** Own xterm immediately so input typed while Agent.create runs is not lost. */
export function bufferedXtermAdapter(term: XtermLike, now: () => number = performanceNow) {
  const xterm = xtermAdapter(term, now);
  const dataListeners = new Set<(data: string, receivedAt: number) => void>();
  const resizeListeners = new Set<(size: TerminalSize) => void>();
  let bufferedCharacters = 0;
  let bufferedInput: Array<{ data: string; receivedAt: number }> = [];
  let replayScheduled = false;
  let disposed = false;
  const releaseData = xterm.onData((data, receivedAt) => {
    if (!dataListeners.size || replayScheduled) {
      retainBufferedInput(data, receivedAt);
      return;
    }
    for (const listener of dataListeners) listener(data, receivedAt);
  });
  const releaseResize = xterm.onResize((size) => {
    for (const listener of resizeListeners) listener(size);
  });
  return Object.freeze({
    host: Object.freeze({
      write: xterm.write,
      onData(listener: (data: string, receivedAt: number) => void) {
        if (disposed) return () => {};
        dataListeners.add(listener);
        if (bufferedInput.length && !replayScheduled) {
          replayScheduled = true;
          queueMicrotask(() => {
            replayScheduled = false;
            if (disposed) return;
            const input = replayChunks(bufferedInput);
            bufferedInput = [];
            bufferedCharacters = 0;
            for (const chunk of input) {
              for (const current of dataListeners) {
                current(chunk.data, chunk.receivedAt);
              }
            }
          });
        }
        return () => dataListeners.delete(listener);
      },
      onResize(listener: (size: TerminalSize) => void) {
        if (disposed) return () => {};
        resizeListeners.add(listener);
        return () => resizeListeners.delete(listener);
      },
      onScroll: xterm.onScroll,
      get cols() { return xterm.cols; },
      get rows() { return xterm.rows; },
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      bufferedInput = [];
      bufferedCharacters = 0;
      replayScheduled = false;
      dataListeners.clear();
      resizeListeners.clear();
      releaseData();
      releaseResize();
    },
  });

  function retainBufferedInput(data: string, receivedAt: number) {
    if (!data) return;
    bufferedInput.push({ data, receivedAt });
    bufferedCharacters += data.length;
    let overflow = bufferedCharacters - MAX_BUFFERED_INPUT;
    while (overflow > 0 && bufferedInput.length) {
      const first = bufferedInput[0]!;
      if (first.data.length <= overflow) {
        overflow -= first.data.length;
        bufferedCharacters -= first.data.length;
        bufferedInput.shift();
        continue;
      }
      first.data = first.data.slice(overflow);
      bufferedCharacters -= overflow;
      overflow = 0;
    }
  }

  function replayChunks(chunks: Array<{ data: string; receivedAt: number }>) {
    const replay: Array<{ data: string; receivedAt: number }> = [];
    let paste: { data: string; receivedAt: number } | undefined;
    for (const chunk of chunks) {
      if (!paste && !chunk.data.startsWith(BRACKETED_PASTE_START)) {
        replay.push(chunk);
        continue;
      }
      paste = {
        data: `${paste?.data ?? ""}${chunk.data}`,
        receivedAt: chunk.receivedAt,
      };
      const end = paste.data.indexOf(BRACKETED_PASTE_END);
      if (end < 0) continue;
      const boundary = end + BRACKETED_PASTE_END.length;
      replay.push({ data: paste.data.slice(0, boundary), receivedAt: paste.receivedAt });
      if (boundary < paste.data.length) {
        replay.push({ data: paste.data.slice(boundary), receivedAt: paste.receivedAt });
      }
      paste = undefined;
    }
    if (paste) replay.push(paste);
    return replay;
  }
}

function performanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
