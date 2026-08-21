import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/Docs.tsx", import.meta.url), "utf8");

test("docs pages advertise client-side previous and next keyboard shortcuts", () => {
  assert.match(source, /import \{ Link, useLocation, useNavigate \} from "react-router"/);
  assert.match(source, /event\.key === "ArrowLeft"[\s\S]*?previous/);
  assert.match(source, /event\.key === "ArrowRight"[\s\S]*?next/);
  assert.match(source, /navigate\(destination\.href\)/);
  assert.match(source, /aria-keyshortcuts="Shift\+ArrowLeft"/);
  assert.match(source, /aria-keyshortcuts="Shift\+ArrowRight"/);
  assert.match(source, /title="Previous page \(Shift \+ Left Arrow\)"/);
  assert.match(source, /title="Next page \(Shift \+ Right Arrow\)"/);
});

test("docs paging ignores modified, editable, editor, and non-docs targets", () => {
  assert.match(source, /!event\.shiftKey[\s\S]*?event\.altKey[\s\S]*?event\.ctrlKey[\s\S]*?event\.metaKey/);
  for (const target of [
    "input",
    "textarea",
    "select",
    "button",
    "contenteditable",
    "monaco-editor",
    "cm-editor",
    "CodeMirror",
    "data-code-editor",
  ]) {
    assert.ok(source.includes(target), `missing ignored target: ${target}`);
  }
  assert.match(source, /docsPage\.contains\(element\) && !element\.closest\(docsPagingIgnoredTarget\)/);
});

test("docs paging prevents native behavior only after resolving an eligible destination", () => {
  const destinationGuard = source.indexOf(
    "if (!destination || !isDocsPagingTarget(event.target, docsPageRef.current)) return;",
  );
  const preventDefault = source.indexOf("event.preventDefault();", destinationGuard);
  const navigate = source.indexOf("navigate(destination.href);", destinationGuard);
  assert.ok(destinationGuard >= 0);
  assert.ok(preventDefault > destinationGuard);
  assert.ok(navigate > preventDefault);
});
