import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const react = await import("nanocodex-react");
const entry = await readFile(new URL("../index.mjs", import.meta.url), "utf8");

assert.equal(typeof react.NanocodexProvider, "function");
assert.equal(typeof react.useNanocodex, "function");
assert.equal(typeof react.useAgentEvents, "function");
assert.equal(typeof react.useConfig, "function");
assert.equal(typeof react.createConfig, "function");
assert.equal(entry.split("\n", 1)[0], '"use client";');
assert.match(entry, /useInsertionEffect\(\(\) => \{/);
assert.match(entry, /const getServerSnapshot = useCallback\(\(\) => IDLE_AGENT_SNAPSHOT, \[\]\);/);
