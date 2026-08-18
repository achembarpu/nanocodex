import { Buffer } from "buffer";

// isomorphic-git still reads Buffer from the global scope in its browser build.
// Install it in every browser/Worker realm before a Git operation can run.
globalThis.Buffer ??= Buffer;
