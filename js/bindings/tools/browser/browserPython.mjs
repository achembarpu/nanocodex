import { defineCommand, } from "just-bash/browser";
export class BrowserPythonRuntime {
    #workspaceRoot;
    #egress;
    #worker;
    #nextId = 1;
    #queue = Promise.resolve();
    constructor(workspaceRoot, egress) {
        this.#workspaceRoot = workspaceRoot;
        this.#egress = egress;
    }
    execute(input, signal) {
        const run = this.#queue.then(() => this.#run(input, signal));
        this.#queue = run.then(() => undefined, () => undefined);
        return run;
    }
    async #run(input, signal) {
        const worker = this.#worker ?? this.#createWorker();
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
                signal?.removeEventListener("abort", onAbort);
            };
            const onMessage = (event) => {
                if (event.data.id !== id)
                    return;
                cleanup();
                // NativeFS can push changes back to OPFS but cannot refresh an existing
                // mount after bash edits. A process-like fresh worker per invocation
                // guarantees each Python command begins from the latest workspace.
                this.#discardWorker(worker);
                if (event.data.result)
                    resolve(event.data.result);
                else
                    reject(new Error(event.data.error ?? "Python worker failed"));
            };
            const onError = (event) => {
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
            if (signal?.aborted)
                return onAbort();
            worker.postMessage({ type: "execute", id, input });
        });
    }
    #createWorker() {
        const worker = new Worker(new URL("./python.worker.mjs", import.meta.url), { type: "module" });
        worker.postMessage({
            type: "initialize",
            workspaceRoot: this.#workspaceRoot,
            egress: this.#egress,
        });
        this.#worker = worker;
        return worker;
    }
    #discardWorker(worker) {
        worker.terminate();
        if (this.#worker === worker)
            this.#worker = undefined;
    }
}
export function createPythonCommand(name, runtime, filesystem) {
    const execute = async (args, context) => {
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
        }
        catch (error) {
            return {
                stdout: "",
                stderr: `python3: ${error instanceof Error ? error.message : String(error)}\n`,
                exitCode: context.signal?.aborted ? 124 : 1,
            };
        }
    };
    return defineCommand(name, execute);
}
