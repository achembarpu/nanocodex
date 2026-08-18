import {
  defineCommand,
  type ExecResult,
  type IFileSystem,
  type ResolvedCommandContext,
} from "just-bash/browser";

export type PythonExecution = {
  args: string[];
  cwd: string;
  stdin: string;
};

export interface PythonRuntime {
  execute(input: PythonExecution, signal?: AbortSignal): Promise<ExecResult>;
}

type WorkerResponse = {
  id: number;
  result?: ExecResult;
  error?: string;
};

export class BrowserPythonRuntime implements PythonRuntime {
  readonly #workspaceRoot: FileSystemDirectoryHandle;
  #worker: Worker | undefined;
  #nextId = 1;
  #queue = Promise.resolve();

  constructor(workspaceRoot: FileSystemDirectoryHandle) {
    this.#workspaceRoot = workspaceRoot;
  }

  execute(input: PythonExecution, signal?: AbortSignal): Promise<ExecResult> {
    const run = this.#queue.then(() => this.#run(input, signal));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #run(input: PythonExecution, signal?: AbortSignal): Promise<ExecResult> {
    const worker = this.#worker ?? this.#createWorker();
    const id = this.#nextId++;
    return new Promise<ExecResult>((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onMessage = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) return;
        cleanup();
        // NativeFS can push changes back to OPFS but cannot refresh an existing
        // mount after bash edits. A process-like fresh worker per invocation
        // guarantees each Python command begins from the latest workspace.
        this.#discardWorker(worker);
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error ?? "Python worker failed"));
      };
      const onError = (event: ErrorEvent) => {
        cleanup();
        this.#discardWorker(worker);
        reject(new Error(event.message || "Python worker crashed"));
      };
      const onAbort = () => {
        cleanup();
        this.#discardWorker(worker);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Python execution aborted"));
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      worker.postMessage({ type: "execute", id, input });
    });
  }

  #createWorker(): Worker {
    const worker = new Worker(new URL("./python.worker.ts", import.meta.url), { type: "module" });
    worker.postMessage({ type: "initialize", workspaceRoot: this.#workspaceRoot });
    this.#worker = worker;
    return worker;
  }

  #discardWorker(worker: Worker): void {
    worker.terminate();
    if (this.#worker === worker) this.#worker = undefined;
  }
}

export function pythonCommands(
  runtime: PythonRuntime | undefined,
  filesystem: IFileSystem & { refreshPaths?: () => Promise<void>; recordRepositoryMutation?: () => void },
) {
  const execute = async (
    args: string[],
    context: ResolvedCommandContext,
  ): Promise<ExecResult> => {
    if (!runtime) {
      return {
        stdout: "",
        stderr: "python3: browser Python is unavailable without an OPFS workspace\n",
        exitCode: 1,
      };
    }
    try {
      const result = await runtime.execute({
        args,
        cwd: context.cwd,
        stdin: String(context.stdin),
      }, context.signal);
      await filesystem.refreshPaths?.();
      filesystem.recordRepositoryMutation?.();
      return result;
    } catch (error) {
      return {
        stdout: "",
        stderr: `python3: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: context.signal?.aborted ? 124 : 1,
      };
    }
  };
  return [
    defineCommand("python3", execute),
    defineCommand("python", execute),
  ];
}
