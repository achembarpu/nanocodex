type TerminalSize = Readonly<{ cols: number; rows: number }>;
const MAX_BUFFERED_INPUT = 64 * 1024;

type XtermLike = {
  write(data: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: TerminalSize) => void): { dispose(): void };
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
export function xtermAdapter(term: XtermLike) {
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
    write: (data: string | Uint8Array) =>
      term.write(typeof data === "string" ? data : new TextDecoder().decode(data)),
    onData(callback: (data: string) => void) {
      const data = term.onData(callback);
      keyDataHandler = callback;
      return () => {
        data.dispose();
        if (keyDataHandler === callback) keyDataHandler = undefined;
      };
    },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    onResize(callback: (size: TerminalSize) => void) {
      const disposable = term.onResize(({ cols, rows }) => callback({ cols, rows }));
      return () => disposable.dispose();
    },
  };
}

/** Own xterm immediately so input typed while Agent.create runs is not lost. */
export function bufferedXtermAdapter(term: XtermLike) {
  const xterm = xtermAdapter(term);
  const dataListeners = new Set<(data: string) => void>();
  const resizeListeners = new Set<(size: TerminalSize) => void>();
  let bufferedInput = "";
  let disposed = false;
  const releaseData = xterm.onData((data) => {
    if (!dataListeners.size) {
      bufferedInput = `${bufferedInput}${data}`.slice(-MAX_BUFFERED_INPUT);
      return;
    }
    for (const listener of dataListeners) listener(data);
  });
  const releaseResize = xterm.onResize((size) => {
    for (const listener of resizeListeners) listener(size);
  });
  return Object.freeze({
    host: Object.freeze({
      write: xterm.write,
      onData(listener: (data: string) => void) {
        if (disposed) return () => {};
        dataListeners.add(listener);
        if (bufferedInput) {
          const input = bufferedInput;
          bufferedInput = "";
          queueMicrotask(() => {
            if (dataListeners.has(listener)) listener(input);
          });
        }
        return () => dataListeners.delete(listener);
      },
      onResize(listener: (size: TerminalSize) => void) {
        if (disposed) return () => {};
        resizeListeners.add(listener);
        return () => resizeListeners.delete(listener);
      },
      get cols() { return xterm.cols; },
      get rows() { return xterm.rows; },
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      bufferedInput = "";
      dataListeners.clear();
      resizeListeners.clear();
      releaseData();
      releaseResize();
    },
  });
}
