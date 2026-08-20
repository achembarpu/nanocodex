import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/Docs.css", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/Docs.tsx", import.meta.url), "utf8");
const syntax = readFileSync(new URL("../src/docsSyntax.tsx", import.meta.url), "utf8");

test("documentation uses a full-width shell and readable heading scale", () => {
  assert.match(css, /\.docs-layout \{[\s\S]*?width:\s*100%;[\s\S]*?padding:\s*56px var\(--page-margin\) 112px/);
  assert.match(css, /\.docs-article h1 \{[\s\S]*?font-size:\s*28px/);
  assert.match(css, /\.docs-article h2 \{[\s\S]*?font-size:\s*20px/);
});

test("documentation navigation stays client-side and code uses themed syntax tokens", () => {
  assert.match(source, /import \{ Link, useLocation \} from "react-router"/);
  assert.match(source, /<Link to=\{previous\[1\]\}>/);
  assert.match(source, /<Link to=\{href\}/);
  assert.doesNotMatch(source, /<a href="\/docs"/);
  assert.match(source, /highlightDocsCode\(code, language\)/);
  assert.match(syntax, /createHighlighterCoreSync/);
  assert.match(syntax, /pierre-light/);
  assert.match(syntax, /pierre-dark-soft/);
  assert.match(css, /--shiki-light/);
  assert.match(css, /--shiki-dark/);
});

test("documentation drawers and pagination keep mobile targets and focus containment", () => {
  assert.match(css, /\.docs-drawer nav a \{[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.docs-pagination > a \{[\s\S]*?min-height:\s*44px/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /last\.focus\(\)/);
  assert.match(source, /first\.focus\(\)/);
  assert.match(source, /matchMedia\("\(min-width: 901px\)"\)/);
});
