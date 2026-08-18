import { ChatGptSubscription as WasmChatGptSubscription } from "../pkg-web/nanocodex_worker.js";

import { installHostBridge } from "../internal.mjs";
import { openSubscription } from "../runtime/chatgpt-subscription.mjs";

/** Opens the Rust-owned ChatGPT lifecycle in a module Worker. */
export function open(options) {
  installHostBridge();
  return openSubscription(options, (config) => WasmChatGptSubscription.open(config));
}
