/// <reference lib="webworker" />

import { API } from "@eduoj/wasm-clang";

type CompilerFile = { path: string; contents: Uint8Array };
type CompilerInput = {
  files: CompilerFile[];
  sources: string[];
  output: string;
  optimize: string;
  compileOnly: boolean;
};

type ClangApi = {
  ready: Promise<void>;
  memfs: {
    addDirectory(path: string): void;
    addFile(path: string, contents: Uint8Array): void;
    getFileContents(path: string): Uint8Array;
  };
  compile(options: {
    input: string;
    contents: Uint8Array;
    obj: string;
    opt: string;
    clangFlags: string[];
  }): Promise<unknown>;
  getModule(path: string): Promise<WebAssembly.Module>;
  run(module: WebAssembly.Module, ...args: string[]): Promise<unknown>;
  cdnUrl: string;
  lldFilename: string;
};

let apiPromise: Promise<ClangApi> | undefined;
let diagnostics = "";
const knownDirectories = new Set<string>();

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as { type?: unknown; id?: unknown; input?: unknown };
  if (message.type !== "compile" || typeof message.id !== "number") return;
  void compile(message.id, message.input as CompilerInput);
});

async function compile(id: number, input: CompilerInput): Promise<void> {
  diagnostics = "";
  try {
    const api = await runtime();
    await api.ready;
    const prefix = `.nanocodex-runs/run-${id}`;
    addDirectories(api, [`${prefix}/.keep`, ...input.files.map((file) => `${prefix}/${file.path}`)]);
    for (const file of input.files) api.memfs.addFile(`${prefix}/${file.path}`, file.contents);
    addDirectories(api, [`${prefix}/objects/.keep`]);
    const objects: string[] = [];
    for (let index = 0; index < input.sources.length; index += 1) {
      const relativeSource = workspaceRelative(input.sources[index]);
      const file = input.files.find((candidate) => candidate.path === relativeSource);
      if (!file) throw new Error(`input file not found: ${relativeSource}`);
      const source = `${prefix}/${relativeSource}`;
      const object = `${prefix}/objects/${index}.o`;
      await api.compile({
        input: source,
        contents: file.contents,
        obj: object,
        opt: input.optimize,
        clangFlags: ["-triple", "wasm32-unknown-wasi"],
      });
      objects.push(object);
    }
    const generated = input.compileOnly
      ? objects[0]
      : await link(api, objects, prefix);
    const bytes = api.memfs.getFileContents(generated).slice();
    const result = {
      stdout: "",
      stderr: diagnostics,
      exitCode: 0,
      output: bytes,
    };
    self.postMessage({ id, result }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({
      id,
      result: {
        stdout: "",
        stderr: `${diagnostics}${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      },
    });
  }
}

async function runtime(): Promise<ClangApi> {
  if (!apiPromise) {
    apiPromise = Promise.resolve(new API({
      hostWrite: (message: string) => diagnostics += message,
      readBuffer: async (url: string) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`compiler asset failed: HTTP ${response.status}`);
        return response.arrayBuffer();
      },
      compileStreaming: async (url: string) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`compiler asset failed: HTTP ${response.status}`);
        return WebAssembly.compile(await response.arrayBuffer());
      },
    }) as ClangApi);
  }
  return apiPromise;
}

async function link(api: ClangApi, objects: string[], prefix: string): Promise<string> {
  const output = `${prefix}/output.wasm`;
  const libdir = "lib/wasm32-wasi";
  const lld = await api.getModule(api.cdnUrl + api.lldFilename);
  await api.run(
    lld,
    "wasm-ld",
    "--no-threads",
    "--export-dynamic",
    "-z",
    "stack-size=1048576",
    `-L${libdir}`,
    `${libdir}/crt1.o`,
    ...objects,
    "-lc",
    "-lc++",
    "-lc++abi",
    "-lcanvas",
    "-o",
    output,
  );
  return output;
}

function addDirectories(api: ClangApi, paths: string[]): void {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  for (const directory of [...directories].sort()) {
    if (knownDirectories.has(directory)) continue;
    api.memfs.addDirectory(directory);
    knownDirectories.add(directory);
  }
}

function workspaceRelative(path: string): string {
  return path.replace(/^\/workspace\//, "").replace(/^\/+/, "");
}
