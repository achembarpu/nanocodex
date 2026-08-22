import {
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
  useWorkerPool,
} from "@pierre/diffs/react";
import {
  getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";
import {
  getFiletypeFromFileName,
  type CodeViewItem,
  type FileContents,
  type FileDiffMetadata,
  type SupportedLanguages,
} from "@pierre/diffs";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CODE_VIEW_THEMES, COMPACT_WORKSPACE_QUERY } from "./pierreCodeView";
import { createRetainedResourceLease } from "./retainedResource";
import {
  itemSyntaxLanguages,
  sourceFileContents,
  syntaxLanguagesForPaths,
} from "./sourceHighlight";
import type { RepositoryFile } from "./threadRepositorySnapshot";

const highlighterOptions: WorkerInitializationRenderOptions = {
  theme: CODE_VIEW_THEMES,
  preferredHighlighter: "shiki-js",
};

const PRELOADED_WORKER_RETENTION_MS = 30_000;
let preloadedWorker: Worker | undefined;
let preloadedWorkerExpiry: ReturnType<typeof setTimeout> | undefined;
let sharedPoolOptions: WorkerPoolOptions | undefined;
const preloadedPoolLease = createRetainedResourceLease(
  PRELOADED_WORKER_RETENTION_MS,
  terminateWorkerPoolSingleton,
);

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

function poolOptions(): WorkerPoolOptions {
  return sharedPoolOptions ??= {
    poolSize: 1,
    totalASTLRUCacheSize: sourceHighlightCacheSize(),
    workerFactory: createDiffWorker,
  };
}

function pierreWorkerPool(
  languages: SupportedLanguages[] = [],
): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton({
    poolOptions: poolOptions(),
    highlighterOptions: { ...highlighterOptions, langs: languages },
  });
}

export async function preloadPierreLanguages(
  languages: readonly SupportedLanguages[],
): Promise<void> {
  const unique = [...new Set(languages)].filter(
    (language): language is Exclude<SupportedLanguages, "text" | "ansi"> =>
      language !== "text" && language !== "ansi",
  );
  preloadPierreWorker();
  await pierreWorkerPool(unique).initialize(unique);
}

export async function preloadPierrePaths(paths: readonly string[]): Promise<void> {
  try {
    await preloadPierreLanguages(syntaxLanguagesForPaths(paths));
  } finally {
    preloadedPoolLease.retain();
  }
}

export async function preloadPierreFile(
  file: RepositoryFile,
  contents: string,
): Promise<void> {
  try {
    await preparePierreItems([{
      id: `preload:${file.objectId}:${file.path}`,
      type: "file",
      file: sourceFileContents(file, contents),
    }]);
  } finally {
    preloadedPoolLease.retain();
  }
}

export async function preparePierreItems(
  items: readonly CodeViewItem<undefined>[],
): Promise<void> {
  if (items.length === 0) return;
  const languages = itemSyntaxLanguages(items);
  await preloadPierreLanguages(languages);
  const pool = pierreWorkerPool(languages);
  for (const item of items) requireHighlightCacheKey(item);
  if (arePierreItemsPrepared(pool, items)) return;

  await new Promise<void>((resolve, reject) => {
    let primed = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const inspect = () => {
      if (!primed || settled) return;
      if (arePierreItemsPrepared(pool, items)) {
        finish();
        return;
      }
      const stats = pool.getStats();
      if (stats.workersFailed) {
        finish(new Error("Pierre highlight Worker failed"));
      } else if (
        stats.managerState === "initialized"
        && stats.queuedTasks === 0
        && stats.activeTasks === 0
      ) {
        finish(new Error("Pierre highlight preparation completed without a cached AST"));
      }
    };

    timeout = setTimeout(
      () => finish(new Error("Pierre highlight preparation timed out")),
      PRELOADED_WORKER_RETENTION_MS,
    );
    unsubscribe = pool.subscribeToStatChanges(inspect);
    for (const item of items) {
      if (item.type === "file") pool.primeFileHighlightCache(item.file);
      else pool.primeDiffHighlightCache(item.fileDiff);
    }
    primed = true;
    inspect();
  });
}

function arePierreItemsPrepared(
  pool: WorkerPoolManager | undefined,
  items: readonly CodeViewItem<undefined>[],
): boolean {
  if (pool == null) return true;
  return items.every((item) => {
    if (item.type === "file") {
      return isPlainFile(item.file) || pool.getFileResultCache(item.file) != null;
    }
    return isPlainDiff(item.fileDiff) || pool.getDiffResultCache(item.fileDiff) != null;
  });
}

function requireHighlightCacheKey(item: CodeViewItem<undefined>): void {
  if (item.type === "file") {
    if (!isPlainFile(item.file) && item.file.cacheKey == null) {
      throw new Error(`Pierre file ${item.file.name} has no highlight cache key`);
    }
  } else if (!isPlainDiff(item.fileDiff) && item.fileDiff.cacheKey == null) {
    throw new Error(`Pierre diff ${item.fileDiff.name} has no highlight cache key`);
  }
}

function isPlainFile(file: FileContents): boolean {
  return (file.lang ?? getFiletypeFromFileName(file.name)) === "text";
}

function isPlainDiff(diff: FileDiffMetadata): boolean {
  const current = diff.lang ?? getFiletypeFromFileName(diff.name);
  const previous = diff.lang ?? getFiletypeFromFileName(diff.prevName ?? "-");
  return current === "text" && previous === "text";
}

export function PierreWorkerProvider({ children }: { children: ReactNode }) {
  useEffect(() => preloadedPoolLease.acquire(), []);
  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions()}
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

  const prepareItems = useCallback(
    (items: readonly CodeViewItem<undefined>[]) => preparePierreItems(items),
    [],
  );
  return {
    disableWorkerPool: workerPool == null,
    preparationBatchSize: poolOptions().totalASTLRUCacheSize ?? 1,
    prepareItems,
    ready,
  };
}
