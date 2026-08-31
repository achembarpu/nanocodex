const PREPARED_BROWSER = Symbol("nanocodex.preparedBrowser");

export function createPreparedBrowser(runtime, release) {
  const state = { disposed: false, release, runtime };
  return Object.freeze({
    origin: runtime.origin,
    threadId: runtime.threadId,
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      releasePreparedBrowser(state);
      state.runtime = undefined;
    },
    [PREPARED_BROWSER]: state,
  });
}

export function usePreparedBrowser(prepared) {
  const state = prepared?.[PREPARED_BROWSER];
  if (!state) throw new TypeError("bindBrowser requires a PreparedBrowser owned by prepareBrowser");
  if (state.disposed) throw new Error("prepared browser runtime has been disposed");
  releasePreparedBrowser(state);
  return state.runtime;
}

function releasePreparedBrowser(state) {
  const release = state.release;
  state.release = undefined;
  release?.();
}
