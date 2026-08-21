import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const application = source("../src/NanocodexApp.tsx");
const css = source("../src/index.css");
const mark = source("../public/paradigm-mark.svg");
const favicon = source("../public/paradigm-favicon.svg");
const document = source("../index.html");

test("the shared header uses Paradigm's locally vendored standalone mark", () => {
  assert.match(
    application,
    /className="brand-parent"[\s\S]*?href="https:\/\/paradigm\.xyz"[\s\S]*?aria-label="Paradigm"[\s\S]*?title="Paradigm"[\s\S]*?<span className="paradigm-mark" aria-hidden="true" \/>/,
  );
  assert.doesNotMatch(application, />\s*Paradigm\s*<\/a>/);
  assert.match(mark, /viewBox="8 7 17 19"/);
  assert.doesNotMatch(mark, /#00FF00|<rect\b/);
  assert.equal((mark.match(/<path\b/g) ?? []).length, 1);
  assert.match(document, /<link rel="icon" href="\/paradigm-favicon\.svg" type="image\/svg\+xml" sizes="any" \/>/);
  assert.match(favicon, /<rect width="32" height="32" fill="#000"\/>/);
  assert.match(favicon, /<path fill="#fff"/);
  assert.match(mark, /prefers-color-scheme:\s*dark/);
});

test("the compact mark keeps the header link and mobile row touch-sized", () => {
  assert.match(css, /\.brand-parent,[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.brand-parent:focus-visible[\s\S]*?color:\s*var\(--text\)/);
  assert.match(css, /\.paradigm-mark\s*\{[\s\S]*?width:\s*16px[\s\S]*?height:\s*18px[\s\S]*?background:\s*var\(--text\)[\s\S]*?url\("\/paradigm-mark\.svg"\)/);
  assert.match(css, /\.paradigm-mark\s*\{[\s\S]*?transform:\s*translateY\(0\.5px\)/);
  assert.match(css, /\.brand-parent:focus-visible \.paradigm-mark[\s\S]*?opacity:\s*1/);
  assert.match(css, /:root\s*\{[\s\S]*?--text:\s*var\(--white\)/);
  assert.match(css, /html\[data-theme="light"\]\s*\{[\s\S]*?--text:\s*var\(--black\)/);
  assert.match(css, /@media \(max-width: 740px\)[\s\S]*?\.paradigm-mark\s*\{[\s\S]*?width:\s*15px[\s\S]*?height:\s*17px/);
});

test("the Nanocodex wordmark is correctly cased, mono, and theme-aware", () => {
  assert.match(application, /surface === "home" \? "wordmark is-active" : "wordmark"/);
  assert.match(application, />\s*Nanocodex\s*<\/a>/);
  assert.doesNotMatch(application, /<span aria-hidden="true">\/<\/span>/);
  assert.match(
    css,
    /\.wordmark\s*\{[\s\S]*?color:\s*var\(--text\)[\s\S]*?font-family:\s*var\(--font-mono\)/,
  );
  assert.doesNotMatch(css, /\.site-brand \.wordmark[^}]*color:\s*var\(--white\)/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
