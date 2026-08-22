import {
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
  useWorkerPool,
} from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CODE_VIEW_THEMES, COMPACT_WORKSPACE_QUERY } from "./pierreCodeView";

const highlighterOptions: WorkerInitializationRenderOptions = {
  theme: CODE_VIEW_THEMES,
  preferredHighlighter: "shiki-js",
};

const PRELOADED_WORKER_RETENTION_MS = 30_000;
let preloadedWorker: Worker | undefined;
let preloadedWorkerExpiry: ReturnType<typeof setTimeout> | undefined;

export function preloadPierreWorker(): void {
  if (preloadedWorker == null) {
    if (typeof Worker === "undefined") return;
    preloadedWorker = new DiffWorker();
  }
  clearTimeout(preloadedWorkerExpiry);
  const expiry = setTimeout(() => {
    if (preloadedWorkerExpiry !== expiry) return;
    preloadedWorker?.terminate();
    preloadedWorker = undefined;
    preloadedWorkerExpiry = undefined;
  }, PRELOADED_WORKER_RETENTION_MS);
  preloadedWorkerExpiry = expiry;
}

function createDiffWorker(): Worker {
  clearTimeout(preloadedWorkerExpiry);
  preloadedWorkerExpiry = undefined;
  const worker = preloadedWorker ?? new DiffWorker();
  preloadedWorker = undefined;
  return worker;
}

export function sourceHighlightCacheSize(): number {
  if (typeof window === "undefined") return 100;
  return window.matchMedia(COMPACT_WORKSPACE_QUERY).matches ? 10 : 100;
}

export function PierreWorkerProvider({ children }: { children: ReactNode }) {
  const poolOptions = useMemo<WorkerPoolOptions>(() => ({
    poolSize: 1,
    totalASTLRUCacheSize: sourceHighlightCacheSize(),
    workerFactory: createDiffWorker,
  }), []);
  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}

export function usePierreRenderer() {
  const workerPool = useWorkerPool();
  const [ready, setReady] = useState(() => workerPool?.isInitialized() ?? true);
  const readyRef = useRef(ready);

  useEffect(() => {
    return workerPool?.subscribeToStatChanges((stats) => {
      const nextReady = stats.managerState === "initialized";
      if (nextReady !== readyRef.current) {
        readyRef.current = nextReady;
        setReady(nextReady);
      }
    });
  }, [workerPool]);

  return { ready, disableWorkerPool: workerPool == null };
}
