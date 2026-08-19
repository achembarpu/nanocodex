import { Buffer } from "buffer";
// isomorphic-git still reads Buffer from the global scope in its browser build.
// Install it in every browser/Worker realm before a Git operation can run.
globalThis.Buffer ??= Buffer;
// A few CommonJS browser libraries (notably the SSH stream dependencies) use
// Node's `global` spelling even when their implementation selects Web Crypto.
const commonJsGlobal = globalThis;
commonJsGlobal.global ??= globalThis;
commonJsGlobal.process ??= { versions: {} };
