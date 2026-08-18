import { DEFAULT_THEMES } from "@pierre/diffs";
import {
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
  useWorkerPool,
} from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

const poolOptions: WorkerPoolOptions = {
  poolSize: 1,
  totalASTLRUCacheSize: 100,
  workerFactory: () => new DiffWorker(),
};

const highlighterOptions: WorkerInitializationRenderOptions = {
  theme: DEFAULT_THEMES,
  preferredHighlighter: "shiki-js",
};

export function PierreWorkerProvider({ children }: { children: ReactNode }) {
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
