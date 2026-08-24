import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm, type Terminal as XtermInstance } from "@xterm/xterm";
import { availableVisualHeight } from "./agentTerminalLifecycle";
import { bufferedXtermAdapter, isTerminalSubmitKeyEvent } from "./agentTerminalXterm";
import type { AgentStatus, AgentTerminalMode } from "./agentTerminalTypes";
import type { TerminalHost } from "./demoTerminal";
import {
  COARSE_POINTER_QUERY,
  cssPixelValue,
  observeMediaQueryMatch,
  terminalComposerMinimumHeight,
} from "./mobileInteraction";
import "@xterm/xterm/css/xterm.css";

export type { AgentStatus, AgentTerminalMode } from "./agentTerminalTypes";

export function XtermSurface({
  composer,
  inactiveMessage,
  mode,
  status,
  theme,
  touchInput,
  onReady,
}: {
  composer?: ReactNode;
  inactiveMessage: string;
  mode: AgentTerminalMode;
  status: AgentStatus;
  theme: "light" | "dark";
  touchInput: boolean;
  onReady(terminal: TerminalHost | undefined): void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<XtermInstance | undefined>(undefined);
  const fitAddon = useRef<FitAddon | undefined>(undefined);
  const latest = useRef({ inactiveMessage, mode, status, onReady });
  latest.current = { inactiveMessage, mode, status, onReady };

  useEffect(() => {
    if (!element.current) return;
    const terminal = new Xterm({
      cursorBlink: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      cursorStyle: "block",
      fontFamily: '"Paradigm SemiMono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      screenReaderMode: touchInput,
      scrollback: 5_000,
      scrollOnUserInput: true,
      theme: terminalTheme(theme),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    fit.fit();
    fitAddon.current = fit;
    instance.current = terminal;
    const terminalHost = bufferedXtermAdapter(terminal);
    configureXtermTextarea(terminal, touchInput);
    const releaseTouchScroll = touchInput
      ? bindTouchTerminalScroll(element.current, terminal)
      : () => {};
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        if (latest.current.mode === "hidden" || !element.current?.isConnected) return;
        fit.fit();
        const current = latest.current;
        if (current.status !== "ready" && current.status !== "starting") {
          writeInactiveFrame(terminal, current.inactiveMessage);
        }
      });
    });
    observer.observe(element.current);
    latest.current.onReady(terminalHost.host);
    if (latest.current.mode === "full" && !touchInput) terminal.focus();
    return () => {
      window.cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      latest.current.onReady(undefined);
      releaseTouchScroll();
      terminalHost.dispose();
      terminal.dispose();
      fitAddon.current = undefined;
      instance.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (instance.current) configureXtermTextarea(instance.current, touchInput);
  }, [touchInput]);

  useLayoutEffect(() => {
    const terminal = instance.current;
    const fit = fitAddon.current;
    const host = element.current;
    if (!terminal || !fit || !host) return;
    if (mode === "hidden") {
      if (host.parentElement?.contains(window.document.activeElement)) {
        (window.document.activeElement as HTMLElement | null)?.blur();
      }
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (!host.isConnected || host.offsetParent === null) return;
      fit.fit();
      if (mode === "full" && !touchInput) terminal.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mode, touchInput]);

  useEffect(() => {
    if (instance.current) instance.current.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    const host = element.current;
    const terminal = instance.current;
    const fit = fitAddon.current;
    const root = host?.closest<HTMLElement>(".nanocodex-demo");
    const shell = host?.parentElement;
    if (!host || !terminal || !fit || !root || !shell) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!host.isConnected || mode === "hidden") return;
        if (viewport) {
          const available = availableVisualHeight({
            elementTop: root.getBoundingClientRect().top,
            viewportHeight: viewport.height,
            viewportOffsetTop: viewport.offsetTop,
          });
          root.style.setProperty("--terminal-visual-height", `${available}px`);
          if (mode === "full") {
            root.style.height = `${available}px`;
          }
          if (
            touchInput
            && (mode === "preview" || mode === "full")
            && shell.contains(window.document.activeElement)
          ) {
            shell.style.removeProperty("height");
            const naturalHeight = shell.getBoundingClientRect().height;
            const composer = shell.querySelector<HTMLElement>(".agent-touch-composer");
            const composerMinimum = terminalComposerMinimumHeight({
              measuredComposerHeight: composer?.getBoundingClientRect().height ?? 0,
              safeAreaInsetBottom: composer
                ? cssPixelValue(window.getComputedStyle(composer).paddingBottom)
                : 0,
            });
            const shellAvailable = availableVisualHeight({
              elementTop: shell.getBoundingClientRect().top,
              minimum: composerMinimum,
              viewportHeight: viewport.height,
              viewportOffsetTop: viewport.offsetTop,
            });
            shell.style.height = `${Math.min(naturalHeight, shellAvailable)}px`;
          } else if (mode === "preview" || mode === "full") {
            shell.style.removeProperty("height");
          }
        } else if (mode === "full") {
          root.style.height = "100%";
        }
        if (host.offsetParent === null) return;
        fit.fit();
      });
    };
    measure();
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    root.addEventListener("focusin", measure);
    root.addEventListener("focusout", measure);
    window.addEventListener("orientationchange", measure);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      root.removeEventListener("focusin", measure);
      root.removeEventListener("focusout", measure);
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--terminal-visual-height");
      shell.style.removeProperty("height");
      if (mode === "full") root.style.removeProperty("height");
    };
  }, [mode, touchInput]);

  useEffect(() => {
    if (status === "ready" || status === "starting" || !instance.current) return;
    writeInactiveFrame(instance.current, inactiveMessage);
  }, [inactiveMessage, status]);

  return (
    <section className="agent-terminal-shell" aria-label="Live Nanocodex terminal">
      <div ref={element} className="agent-xterm" />
      {composer}
    </section>
  );
}

export function TouchTerminalComposer({
  draft,
  pending,
  running,
  status,
  onCancel,
  onChange,
  onSubmit,
}: {
  draft: string;
  pending: boolean;
  running: boolean;
  status: AgentStatus;
  onCancel(): void;
  onChange(value: string): void;
  onSubmit(value: string, intent: "queue" | "steer"): void;
}) {
  const composing = useRef(false);
  const submit = () => {
    if (pending || !draft.trim()) return;
    onSubmit(draft, running ? "steer" : "queue");
  };
  return (
    <form
      className={`agent-touch-composer${running ? " is-running" : ""}`}
      aria-label="Nanocodex message composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span className="agent-touch-rail" aria-hidden="true">│</span>
      <textarea
        aria-label="Message Nanocodex"
        enterKeyHint="send"
        placeholder="Message Nanocodex"
        rows={1}
        value={draft}
        onChange={(event) => onChange(event.currentTarget.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (!isTerminalSubmitKeyEvent(event.nativeEvent, composing.current)) return;
          event.preventDefault();
          submit();
        }}
      />
      <div className="agent-touch-actions">
        {running ? (
          <button type="button" disabled={status !== "ready"} onClick={onCancel}>Stop</button>
        ) : (
          <button type="submit" disabled={pending || !draft.trim()}>Send</button>
        )}
      </div>
      <small>enter send · shift+enter newline</small>
    </form>
  );
}

export function useTouchInput() {
  const [matches, setMatches] = useState(() => window.matchMedia(COARSE_POINTER_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(COARSE_POINTER_QUERY);
    return observeMediaQueryMatch(query, setMatches);
  }, []);
  return matches;
}

function configureXtermTextarea(terminal: XtermInstance, touchInput: boolean) {
  terminal.options.screenReaderMode = touchInput;
  const textarea = terminal.textarea;
  if (!textarea) return;
  textarea.setAttribute("aria-label", "Nanocodex terminal input");
  textarea.readOnly = touchInput;
  textarea.disabled = touchInput;
  textarea.inert = touchInput;
  textarea.tabIndex = touchInput ? -1 : 0;
  textarea.removeAttribute("aria-hidden");
  if (touchInput && textarea === window.document.activeElement) textarea.blur();
}

function bindTouchTerminalScroll(host: HTMLElement, terminal: XtermInstance): () => void {
  let gesture: { identifier: number; lastY: number; remainder: number } | undefined;

  const rowHeight = () => Math.max(
    1,
    host.querySelector<HTMLElement>(".xterm-rows > div")?.getBoundingClientRect().height
      ?? (terminal.options.fontSize ?? 14) * (terminal.options.lineHeight ?? 1),
  );
  const touchForGesture = (touches: TouchList) => {
    if (!gesture) return undefined;
    return Array.from(touches).find(({ identifier }) => identifier === gesture?.identifier);
  };
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      gesture = undefined;
      return;
    }
    const touch = event.touches.item(0);
    if (!touch) return;
    gesture = { identifier: touch.identifier, lastY: touch.clientY, remainder: 0 };
  };
  const move = (event: TouchEvent) => {
    const touch = touchForGesture(event.touches);
    if (!touch || !gesture) return;
    gesture.remainder += gesture.lastY - touch.clientY;
    gesture.lastY = touch.clientY;
    const lineHeight = rowHeight();
    const lines = Math.trunc(gesture.remainder / lineHeight);
    if (lines !== 0) {
      terminal.scrollLines(lines);
      gesture.remainder -= lines * lineHeight;
    }
    event.preventDefault();
  };
  const end = (event: TouchEvent) => {
    if (!gesture) return;
    if (!Array.from(event.changedTouches).some(({ identifier }) => identifier === gesture?.identifier)) {
      return;
    }
    gesture = undefined;
  };

  host.addEventListener("touchstart", start, { passive: true });
  host.addEventListener("touchmove", move, { passive: false });
  host.addEventListener("touchend", end, { passive: true });
  host.addEventListener("touchcancel", end, { passive: true });
  return () => {
    gesture = undefined;
    host.removeEventListener("touchstart", start);
    host.removeEventListener("touchmove", move);
    host.removeEventListener("touchend", end);
    host.removeEventListener("touchcancel", end);
  };
}

function writeInactiveFrame(terminal: XtermInstance, message: string) {
  const gap = Math.max(1, terminal.rows - 3);
  terminal.write(
    `\x1b[3J\x1b[2J\x1b[H\x1b[?25l\x1b[1mnanocodex\x1b[0m${"\r\n".repeat(gap)}\x1b[2m  ${message}\x1b[0m`,
  );
}

function terminalTheme(theme: "light" | "dark") {
  return theme === "dark"
    ? {
        background: "#161616",
        foreground: "#ffffff",
        cursor: "#ffffff",
        cursorAccent: "#161616",
        selectionBackground: "#333333",
        black: "#161616",
        brightBlack: "#999999",
        red: "#ff8585",
        cyan: "#0a82e1",
      }
    : {
        background: "#ffffff",
        foreground: "#000000",
        cursor: "#000000",
        cursorAccent: "#ffffff",
        selectionBackground: "#dddddd",
        black: "#000000",
        brightBlack: "#666666",
        red: "#d53b3b",
        cyan: "#0a82e1",
      };
}
