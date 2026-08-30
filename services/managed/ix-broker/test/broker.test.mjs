import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createIxBrokerServer } from "../broker.mjs";

test("ix broker creates, reconnects, executes, writes, and deletes by id", async (t) => {
  const calls = [];
  const machine = {
    id: "ix-machine-1",
    async delete() { calls.push(["delete"]); },
    async exec(argv) {
      calls.push(["exec", argv]);
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
    },
    async writeFile(path, contents) {
      calls.push(["writeFile", path, Buffer.from(contents)]);
    },
  };
  const machines = {
    async create(options) { calls.push(["create", options]); return machine; },
    connect(id) { calls.push(["connect", id]); return machine; },
  };
  const server = createIxBrokerServer({ machines, token: "secret" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer secret", "content-type": "application/json" };

  const created = await fetch(`${base}/v1/machines`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "thread-1", region: "us-west-1" }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { id: "ix-machine-1" });

  const wrote = await fetch(`${base}/v1/machines/ix-machine-1/files`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ path: "/workspace/blob", base64: "AP+A" }),
  });
  assert.equal(wrote.status, 200);

  const executed = await fetch(`${base}/v1/machines/ix-machine-1/exec`, {
    method: "POST",
    headers,
    body: JSON.stringify({ argv: ["bash", "-lc", "cargo test"] }),
  });
  assert.equal(executed.status, 200);
  assert.deepEqual(await executed.json(), { stdout: "ok\n", stderr: "", exitCode: 0 });

  const deleted = await fetch(`${base}/v1/machines/ix-machine-1`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deleted.status, 200);

  assert.deepEqual(calls, [
    ["create", { name: "thread-1", region: "us-west-1" }],
    ["connect", "ix-machine-1"],
    ["writeFile", "/workspace/blob", Buffer.from([0, 255, 128])],
    ["connect", "ix-machine-1"],
    ["exec", ["bash", "-lc", "cargo test"]],
    ["connect", "ix-machine-1"],
    ["delete"],
  ]);
});

test("ix broker rejects unauthenticated requests", async (t) => {
  const server = createIxBrokerServer({ machines: {}, token: "secret" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/machines`, { method: "POST" });
  assert.equal(response.status, 401);
});
