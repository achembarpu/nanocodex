import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalConversation,
  loadLocalConversations,
  recordLocalConversationPrompt,
} from "../src/localConversationRuntime.ts";

test("browser conversation catalog survives selection and records the first prompt", () => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const initialId = "018f1f9a-7b3c-4a18-8000-000000000018";
  try {
    const initial = loadLocalConversations(initialId);
    const created = createLocalConversation(initial);
    const recorded = recordLocalConversationPrompt(created.conversations, created.conversation.id, "  keep this history  ");
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0]?.title, "keep this history");
    assert.equal(recorded[0]?.turnCount, 1);
    assert.deepEqual(loadLocalConversations(created.conversation.id), recorded);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
