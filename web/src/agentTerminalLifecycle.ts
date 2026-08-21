export class GenerationRequestOwner<T> {
  private current: { generation: number; request: Promise<T> } | undefined;

  run(generation: number, start: () => Promise<T>): Promise<T> {
    if (this.current?.generation === generation) return this.current.request;

    const request = start();
    this.current = { generation, request };
    void request.then(
      () => this.release(request),
      () => this.release(request),
    );
    return request;
  }

  private release(request: Promise<T>) {
    if (this.current?.request === request) this.current = undefined;
  }
}

export function availableVisualHeight({
  elementTop,
  minimum = 0,
  viewportHeight,
  viewportOffsetTop,
}: {
  elementTop: number;
  minimum?: number;
  viewportHeight: number;
  viewportOffsetTop: number;
}): number {
  const relativeTop = elementTop - viewportOffsetTop;
  return Math.max(minimum, Math.floor(viewportHeight - relativeTop));
}

export function terminalRunningForStatus(
  status: "idle" | "starting" | "ready" | "stopped" | "error",
  running: boolean,
): boolean {
  return status === "ready" && running;
}

type WorkerFactory = () => Worker;

export function createPrewarmedWorkerOwner(
  createWorker: WorkerFactory,
  readyTimeoutMs = 45_000,
) {
  let claimed = false;
  let prewarmed: {
    release(): void;
    worker: Worker;
  } | undefined;

  const prewarm = () => {
    if (claimed || prewarmed) return;
    const worker = createWorker();
    const discard = () => {
      if (prewarmed?.worker !== worker) return;
      prewarmed.release();
      prewarmed = undefined;
      worker.terminate();
    };
    const release = () => {
      worker.removeEventListener("error", discard);
      worker.removeEventListener("messageerror", discard);
    };
    prewarmed = { release, worker };
    worker.addEventListener("error", discard);
    worker.addEventListener("messageerror", discard);
    try {
      worker.postMessage({ type: "warmup" });
    } catch (error) {
      discard();
      throw error;
    }
  };

  const claim = () => {
    claimed = true;
    const worker = prewarmed?.worker ?? createWorker();
    prewarmed?.release();
    prewarmed = undefined;
    return withReadyTimeout(worker, readyTimeoutMs);
  };

  return Object.freeze({ claim, prewarm });
}

function withReadyTimeout(worker: Worker, timeoutMs: number): Worker {
  const originalTerminate = worker.terminate.bind(worker);
  let terminated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    worker.removeEventListener("error", cleanup);
    worker.removeEventListener("messageerror", cleanup);
    worker.removeEventListener("message", onMessage);
  };
  const onMessage = (event: MessageEvent<unknown>) => {
    if (!isRecord(event.data)) return;
    if (event.data.type === "ready" || event.data.type === "fatal") cleanup();
  };
  worker.terminate = () => {
    if (terminated) return;
    terminated = true;
    cleanup();
    originalTerminate();
  };
  worker.addEventListener("error", cleanup);
  worker.addEventListener("messageerror", cleanup);
  worker.addEventListener("message", onMessage);
  timer = setTimeout(() => {
    const onerror = worker.onerror;
    worker.terminate();
    if (typeof onerror === "function") {
      onerror.call(worker, {
        message: "Agent worker did not become ready in time",
      } as ErrorEvent);
    }
  }, timeoutMs);
  return worker;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
