import assert from "node:assert/strict";
import { test } from "node:test";

import { BrowserVoiceSession, NanocodexTui } from "nanocodex-tui-react";

test("the installed ESM entry exports the TUI component", () => {
  assert.equal(typeof NanocodexTui, "function");
  assert.equal(typeof BrowserVoiceSession, "function");
});
