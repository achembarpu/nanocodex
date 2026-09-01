import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "../src/docsMarkdown.ts";

test("parses the documentation Markdown subset without changing code bytes", () => {
  const doc = parseDocument(`---
title: "Agent guide"
description: Test page.
---

# Agent guide

An **owned** session uses \`TurnResult\` and [tools](/core/tools-code-mode).

## Build it

- first item
  continues here
- second item

1. start
2. finish

| Surface | Owner |
| --- | --- |
| History | Rust |

\`\`\`js
const turn = await agent.prompt("hello")
await turn.result()
\`\`\`
`);

  assert.equal(doc.title, "Agent guide");
  assert.deepEqual(
    doc.blocks.map((block) => block.type),
    ["heading", "paragraph", "heading", "list", "list", "table", "code"],
  );
  assert.deepEqual(doc.blocks[3], {
    type: "list",
    ordered: false,
    items: ["first item continues here", "second item"],
  });
  assert.deepEqual(doc.blocks[5], {
    type: "table",
    headers: ["Surface", "Owner"],
    rows: [["History", "Rust"]],
  });
  assert.equal(
    doc.blocks[6].type === "code" ? doc.blocks[6].code : "",
    'const turn = await agent.prompt("hello")\nawait turn.result()',
  );
});

test("deduplicates stable heading anchors", () => {
  const doc = parseDocument("# Page\n\n## Result\n\n## Result\n");
  assert.deepEqual(
    doc.blocks.filter((block) => block.type === "heading").map((block) => block.id),
    ["page", "result", "result-2"],
  );
});
