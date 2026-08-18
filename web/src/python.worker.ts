/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from "pyodide";

const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.5/full/";

type PythonExecution = {
  args: string[];
  cwd: string;
  stdin: string;
};

type NativeFs = { syncfs(): Promise<void> };

let workspaceRoot: FileSystemDirectoryHandle | undefined;
let runtimePromise: Promise<{ pyodide: PyodideInterface; nativeFs: NativeFs }> | undefined;

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as {
    type?: unknown;
    id?: unknown;
    input?: unknown;
    workspaceRoot?: unknown;
  };
  if (message.type === "initialize") {
    workspaceRoot = message.workspaceRoot as FileSystemDirectoryHandle;
    return;
  }
  if (message.type !== "execute" || typeof message.id !== "number") return;
  void execute(message.id, message.input as PythonExecution);
});

async function execute(id: number, input: PythonExecution): Promise<void> {
  try {
    const parsed = parseArguments(input.args, input.stdin);
    if ("result" in parsed) {
      self.postMessage({ id, result: parsed.result });
      return;
    }
    const { pyodide, nativeFs } = await runtime();
    await nativeFs.syncfs();
    let stdout = "";
    let stderr = "";
    let stdinOffset = 0;
    pyodide.setStdout({ batched: (line) => stdout += `${line}\n` });
    pyodide.setStderr({ batched: (line) => stderr += `${line}\n` });
    pyodide.setStdin({
      stdin: () => {
        if (stdinOffset >= input.stdin.length) return null;
        const newline = input.stdin.indexOf("\n", stdinOffset);
        const end = newline < 0 ? input.stdin.length : newline + 1;
        const chunk = input.stdin.slice(stdinOffset, end);
        stdinOffset = end;
        return chunk;
      },
      autoEOF: true,
    });
    const globals = pyodide.toPy({
      argv: parsed.argv,
      cwd: input.cwd,
      source: parsed.source ?? "",
      hasSource: parsed.source !== null,
      filename: parsed.filename,
      moduleName: parsed.moduleName ?? "",
      hasModule: parsed.moduleName !== null,
    });
    try {
      await pyodide.runPythonAsync(PYTHON_LAUNCHER, { globals });
      await nativeFs.syncfs();
      self.postMessage({ id, result: { stdout, stderr, exitCode: 0 } });
    } catch (error) {
      await nativeFs.syncfs().catch(() => undefined);
      self.postMessage({
        id,
        result: {
          stdout,
          stderr: `${stderr}${formatPythonError(error)}\n`,
          exitCode: pythonExitCode(error),
        },
      });
    } finally {
      globals.destroy();
    }
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

async function runtime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (!workspaceRoot) throw new Error("Python worker was not initialized");
      const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
      const nativeFs = await pyodide.mountNativeFS("/workspace", workspaceRoot);
      return { pyodide, nativeFs };
    })();
  }
  return runtimePromise;
}

function parseArguments(args: string[], stdin: string):
  | { result: { stdout: string; stderr: string; exitCode: number } }
  | { source: string | null; moduleName: string | null; filename: string; argv: string[] } {
  if (args.includes("--help") || args.includes("-h")) {
    return { result: { stdout: "usage: python3 [-c code | -m module | script | -] [args...]\n", stderr: "", exitCode: 0 } };
  }
  if (args.includes("--version") || args.includes("-V")) {
    return { result: { stdout: "Python 3 (Pyodide)\n", stderr: "", exitCode: 0 } };
  }
  if (args[0] === "-c") {
    if (args[1] === undefined) return argumentError("argument expected for -c");
    return { source: args[1], moduleName: null, filename: "<string>", argv: ["-c", ...args.slice(2)] };
  }
  if (args[0] === "-m") {
    if (args[1] === undefined) return argumentError("argument expected for -m");
    return { source: null, moduleName: args[1], filename: args[1], argv: [args[1], ...args.slice(2)] };
  }
  if (!args.length || args[0] === "-") {
    if (!stdin) return argumentError("no input provided (use -c, -m, a script, or stdin)");
    return { source: stdin, moduleName: null, filename: "<stdin>", argv: ["-", ...args.slice(1)] };
  }
  if (args[0].startsWith("-")) return argumentError(`unrecognized option '${args[0]}'`);
  return { source: null, moduleName: null, filename: args[0], argv: [args[0], ...args.slice(1)] };
}

function argumentError(message: string) {
  return { result: { stdout: "", stderr: `python3: ${message}\n`, exitCode: 2 } } as const;
}

function formatPythonError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Python execution failed";
}

function pythonExitCode(error: unknown): number {
  const match = /SystemExit:\s*(\d+)/.exec(error instanceof Error ? error.message : String(error));
  return match ? Number(match[1]) : 1;
}

const PYTHON_LAUNCHER = `
import os
import runpy
import sys

os.chdir(cwd)
sys.argv = list(argv)
if hasModule:
    runpy.run_module(moduleName, run_name="__main__", alter_sys=True)
elif hasSource:
    scope = {"__name__": "__main__", "__file__": filename}
    exec(compile(source, filename, "exec"), scope, scope)
else:
    runpy.run_path(filename, run_name="__main__")
`;
