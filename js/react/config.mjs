export function createConfig(options) {
  if (typeof options?.worker !== "function") {
    throw new TypeError("createConfig requires worker()");
  }
  const stateListeners = new Set();
  const messageListeners = new Set();
  let snapshot = Object.freeze({ status: "idle", error: undefined });
  let worker;
  let readyMessage;
  let mounts = 0;
  let generation = 0;

  function setSnapshot(status, error) {
    if (snapshot.status === status && snapshot.error === error) return;
    snapshot = Object.freeze({ status, error });
    for (const listener of stateListeners) listener();
  }

  function defaultStartCommand() {
    return {
      type: "start",
      thinking: options.thinking ?? "high",
      reasoningMode: options.reasoningMode ?? "standard",
    };
  }

  function connect(command = defaultStartCommand()) {
    if (worker || snapshot.status === "stopped") return;
    setSnapshot("starting");
    const currentGeneration = ++generation;
    let current;
    try {
      current = options.worker();
      worker = current;
      current.onmessage = ({ data }) => {
        if (worker !== current || generation !== currentGeneration) return;
        if (data?.type === "ready") {
          readyMessage = data;
          setSnapshot("ready");
        }
        if (data?.type === "fatal") {
          closeWorker();
          setSnapshot("error", typeof data.message === "string" ? data.message : "Agent worker failed");
        }
        for (const listener of messageListeners) listener(data);
      };
      current.onerror = (event) => {
        if (worker !== current || generation !== currentGeneration) return;
        closeWorker();
        setSnapshot("error", typeof event?.message === "string" && event.message
          ? event.message
          : "Agent worker failed");
      };
      current.onmessageerror = () => {
        if (worker !== current || generation !== currentGeneration) return;
        closeWorker();
        setSnapshot("error", "Agent worker returned an unreadable message");
      };
      current.postMessage(command);
    } catch (error) {
      if (worker === current) closeWorker();
      else {
        current?.terminate();
        generation += 1;
      }
      setSnapshot("error", errorMessage(error));
    }
  }

  function closeWorker() {
    const current = worker;
    worker = undefined;
    readyMessage = undefined;
    generation += 1;
    if (!current) return;
    current.onmessage = null;
    current.onerror = null;
    current.onmessageerror = null;
    current.terminate();
  }

  function disconnect() {
    closeWorker();
    if (snapshot.status !== "stopped") setSnapshot("idle");
  }

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribeMessages(listener) {
      messageListeners.add(listener);
      if (readyMessage !== undefined) listener(readyMessage);
      return () => messageListeners.delete(listener);
    },
    mount() {
      mounts += 1;
      if (options.autoStart !== false) connect();
      let mounted = true;
      return () => {
        if (!mounted) return;
        mounted = false;
        mounts -= 1;
        if (mounts === 0) disconnect();
      };
    },
    dispatch(command) {
      if (!worker) throw new Error("the Nanocodex worker is not running");
      worker.postMessage(command);
    },
    start(command) {
      connect(command);
    },
    restart(command) {
      if (snapshot.status === "stopped") return;
      disconnect();
      connect(command);
    },
    disconnect,
    stop() {
      if (snapshot.status === "stopped") return;
      closeWorker();
      setSnapshot("stopped");
    },
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
