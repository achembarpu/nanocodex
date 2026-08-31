import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("hibernated Connect sockets fence expiry before inbound and outbound traffic", () => {
  const dispatch = section("async #dispatch(socket:", "async #submitHttpTurn(");
  assert.match(dispatch, /connectGrantExpired\(attachment\.authorization\)[\s\S]*?close\(1008/);

  const send = section("#sendEncoded(socket:", "class ManagedRequestError");
  assert.match(send, /connectGrantExpired\(attachment\.authorization\)[\s\S]*?close\(1008/);
  assert.ok(send.indexOf("connectGrantExpired") < send.indexOf("socket.send(encoded)"));
});

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}
