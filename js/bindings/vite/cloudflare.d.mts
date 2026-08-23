import type { PluginConfig } from "@cloudflare/vite-plugin";
import type { PluginOption } from "vite";

import type { NanocodexChatGptViteOptions } from "./index.mjs";

export type NanocodexCloudflareViteOptions = Readonly<{
  /** Cloudflare Vite plugin options. Nanocodex adds only exact development credential bindings. */
  cloudflare?: PluginConfig | undefined;
  /** Local ChatGPT subscription support is on by default; pass false to disable it. */
  chatGpt?: Pick<NanocodexChatGptViteOptions, "authFile"> | false | undefined;
}>;

/** One call installs browser shims, local subscription brokering, and the Cloudflare Worker plugin. */
export function nanocodex(options?: NanocodexCloudflareViteOptions): PluginOption[];
