import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  CHATGPT_REALTIME_INSTRUCTIONS,
  CODEX_REALTIME_BACKEND_PROMPT,
} from "../browser/realtimePrompt.mjs";

test("browser Realtime uses the canonical Rust voice-side-agent prompt", async () => {
  const rustPrompt = (await readFile(new URL(
    "../../../crates/experimental/nanocodex-voice/src/backend_prompt.md",
    import.meta.url,
  ), "utf8")).trimEnd();
  assert.equal(CODEX_REALTIME_BACKEND_PROMPT, rustPrompt);
  assert.equal(
    CHATGPT_REALTIME_INSTRUCTIONS,
    rustPrompt.replace("{{ user_first_name }}", "there"),
  );
});
