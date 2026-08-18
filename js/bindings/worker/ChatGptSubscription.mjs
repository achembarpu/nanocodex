import init, { ChatGptSubscription as WasmChatGptSubscription } from "../pkg-web/nanocodex.js";
import wasmModule from "../pkg-web/nanocodex_bg.wasm";

import { installHostBridge } from "../internal.mjs";
import { openSubscription } from "../runtime/chatgpt-subscription.mjs";

let initialization;

/** Opens the Rust-owned ChatGPT lifecycle in a module Worker. */
export async function open(options) {
  installHostBridge();
  await initialize();
  return openSubscription(options, (config) => WasmChatGptSubscription.open(config));
}

function initialize() {
  return initialization ??= init({ module_or_path: wasmModule }).catch((error) => {
    initialization = undefined;
    throw error;
  });
}
