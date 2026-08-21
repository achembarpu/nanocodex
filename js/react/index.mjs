import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { createConfig as createBrowserConfig } from "nanocodex/browser";

export { createConfig } from "nanocodex/browser";

const NanocodexContext = createContext(null);

/** Supplies one stable vanilla browser config to Nanocodex hooks. */
export function NanocodexProvider({ children, config }) {
  const fallback = useRef();
  if (!config && !fallback.current) fallback.current = createBrowserConfig();
  return createElement(NanocodexContext.Provider, {
    value: config ?? fallback.current,
  }, children);
}

/** Returns the Agent resource owned by the stable vanilla config. */
export function useAgent(parameters = {}) {
  const config = useConfig(parameters);
  const enabled = parameters.enabled ?? true;
  const threadId = parameters.threadId;
  const resource = useMemo(() => ({ enabled, threadId }), [enabled, threadId]);
  const subscribe = useCallback(
    (listener) => config.subscribeAgent(resource, listener),
    [config, resource],
  );
  const getSnapshot = useCallback(
    () => config.getAgent(resource),
    [config, resource],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refetch = useCallback(() => config.refetchAgent(resource), [config, resource]);
  return useMemo(() => Object.freeze({
    ...snapshot,
    isError: snapshot.status === "error",
    isIdle: snapshot.status === "idle",
    isPending: snapshot.status === "pending",
    isSuccess: snapshot.status === "success",
    refetch,
  }), [refetch, snapshot]);
}

/** Subscribes to ordered typed Agent events without retaining UI state in the SDK. */
export function useAgentEvents(agent, listener, options = {}) {
  const latest = useRef(listener);
  latest.current = listener;
  const includeAllSessions = options.includeAllSessions ?? false;
  useEffect(() => {
    if (!agent) return;
    const watcher = agent.events.watch({ includeAllSessions });
    const release = watcher.onEvent((event) => latest.current(event));
    return () => {
      release();
      watcher.off();
    };
  }, [agent, includeAllSessions]);
}

export function useConfig(parameters = {}) {
  const context = useContext(NanocodexContext);
  const config = parameters.config ?? context;
  if (!config) throw new Error("Nanocodex hooks must be used inside NanocodexProvider");
  return config;
}
