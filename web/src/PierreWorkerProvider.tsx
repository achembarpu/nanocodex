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

let preloadedWorker: Worker | undefined;

export function preloadPierreWorker(): void {
  if (preloadedWorker == null && typeof Worker !== "undefined") {
    preloadedWorker = new DiffWorker();
  }
}

function createDiffWorker(): Worker {
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
