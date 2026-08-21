import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const application = source("../src/NanocodexApp.tsx");
const css = source("../src/index.css");

test("the header copies the shell installer and exposes package commands", () => {
  assert.match(application, /const installCommand = "curl -fsSL https:\/\/nanocodex\.paradigm\.xyz \| bash"/);
  assert.match(application, /command: "cargo add nanocodex"/);
  assert.match(application, /command: "npm install nanocodex"/);
  assert.match(application, /aria-label="Copy Nanocodex install command"/);
  assert.doesNotMatch(application, /title=\{installCommand\}/);
  assert.match(application, /aria-label=\{`Copy \$\{option\.label\} install command`\}/);
  assert.match(application, /navigator\.clipboard\.writeText\(command\)/);
  assert.doesNotMatch(application, /aria-label=\{`Use \$\{theme/);
  assert.doesNotMatch(application, /<Moon|<Sun/);
  assert.match(css, /\.header-install-trigger\s*\{[^}]*background:\s*transparent/);
  assert.match(css, /\.header-install-trigger\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.header-install-trigger:hover,[\s\S]*?background:\s*transparent/);
});

test("the package choices open for pointer, keyboard, and touch-sized focus", () => {
  assert.match(css, /\.header-install:hover \.header-install-menu,[\s\S]*?\.header-install:focus-within \.header-install-menu/);
  assert.match(css, /\.header-install-menu button\s*\{[\s\S]*?min-height:\s*38px/);
  assert.match(css, /grid-template-columns:\s*76px minmax\(0, 1fr\) 12px/);
  assert.match(css, /@media \(max-width: 740px\)[\s\S]*?\.header-install-trigger\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(css, /@media \(max-width: 740px\)[\s\S]*?\.header-install-menu\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(css, /@media \(pointer: coarse\), \(any-pointer: coarse\) \{[\s\S]*?\.header-install-menu button[\s\S]*?min-height:\s*44px/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
