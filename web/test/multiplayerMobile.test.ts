import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexCss = source("../src/index.css");
const multiplayer = source("../src/Multiplayer.tsx");
const multiplayerCss = source("../src/Multiplayer.css");
const monsterWorldCss = source("../src/MonsterWorld.css");
const coarseQuery = "(pointer: coarse), (any-pointer: coarse)";

test("Multiplayer and World subtract the complete compact phone header", () => {
  const phone = indexCss.indexOf("@media (max-width: 740px)", indexCss.indexOf("@media (max-width: 1023px)"));
  assert.notEqual(phone, -1);
  assert.match(
    ruleBlock(indexCss, ":root {", phone),
    /--mobile-header-height:\s*calc\(48px \+ env\(safe-area-inset-top\)\)/,
  );
  assert.doesNotMatch(multiplayerCss, /var\(--header-height\)/);
  assert.doesNotMatch(monsterWorldCss, /var\(--header-height\)/);
  assert.match(multiplayerCss, /min-height:\s*calc\(100dvh - var\(--shell-header-height\)\)/);
  assert.match(
    multiplayerCss,
    /height:\s*calc\(100dvh - var\(--shell-header-height\) - 168px\)/,
  );
  assert.match(monsterWorldCss, /min-height:\s*calc\(100dvh - var\(--shell-header-height\)\)/);
});

test("coarse pointers receive 44px Multiplayer and World controls at every viewport width", () => {
  const multiplayerCoarse = multiplayerCss.indexOf(`@media ${coarseQuery}`);
  const worldCoarse = monsterWorldCss.indexOf(`@media ${coarseQuery}`);
  assert.notEqual(multiplayerCoarse, -1);
  assert.notEqual(worldCoarse, -1);

  const multiplayerTargets = ruleBlock(multiplayerCss, ".multiplayer-lobby input,", multiplayerCoarse);
  assert.match(multiplayerTargets, /\.multiplayer-lobby button/);
  assert.match(multiplayerTargets, /\.multiplayer-room button/);
  assert.match(multiplayerTargets, /min-height:\s*var\(--coarse-target-size\)/);

  const dpad = ruleBlock(monsterWorldCss, ".monster-world-dpad {", worldCoarse);
  assert.match(dpad, /grid-template-columns:\s*repeat\(3, var\(--coarse-target-size\)\)/);
  assert.match(dpad, /grid-template-rows:\s*repeat\(3, var\(--coarse-target-size\)\)/);
  const worldTargets = ruleBlock(monsterWorldCss, ".monster-world-dpad button,", worldCoarse);
  for (const selector of [
    ".monster-world-agent-actions button",
    ".monster-world-talk input",
    ".monster-world-talk button",
    ".monster-world-voice button",
    ".monster-world-population input[type=\"range\"]",
    ".monster-world-resident-exit select",
    ".monster-world-resident-exit button",
    ".monster-world .agent-session-actions button",
    ".monster-world .agent-session-menu summary",
    ".monster-world .agent-oauth-code button",
    ".monster-world .agent-oauth-code a",
  ]) {
    assert.ok(worldTargets.includes(selector), selector);
  }
  assert.match(worldTargets, /min-height:\s*var\(--coarse-target-size\)/);
});

test("Multiplayer follows the transcript tail without stealing a reader's position", () => {
  assert.match(
    multiplayer,
    /const TRANSCRIPT_FOLLOW_THRESHOLD_PX = 80;[\s\S]*?function isNearTranscriptEnd/,
  );
  assert.match(
    multiplayer,
    /scrollHeight - transcript\.clientHeight - transcript\.scrollTop[\s\S]*?remaining <= TRANSCRIPT_FOLLOW_THRESHOLD_PX/,
  );
  assert.match(multiplayer, /onScroll=\{handleTranscriptScroll\}/);
  assert.match(
    multiplayer,
    /if \(newRoom \|\| followTranscript\.current\)[\s\S]*?transcript\.scrollTop = transcript\.scrollHeight[\s\S]*?else if \(added > 0\)[\s\S]*?setUnreadCount/,
  );
  assert.match(
    multiplayer,
    /unreadCount > 0[\s\S]*?className="multiplayer-unread"[\s\S]*?onClick=\{jumpToLatest\}[\s\S]*?Jump to latest/,
  );
  assert.doesNotMatch(
    multiplayer,
    /if \(transcript\) transcript\.scrollTop = transcript\.scrollHeight;\s*\}, \[room\?\.cursor\]\)/,
  );
  assert.match(ruleBlock(multiplayerCss, ".multiplayer-unread {", 0), /min-height:\s*44px/);
});

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function ruleBlock(css: string, selector: string, from: number): string {
  const start = css.indexOf(selector, from);
  assert.notEqual(start, -1, `missing ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(start, close + 1);
}
