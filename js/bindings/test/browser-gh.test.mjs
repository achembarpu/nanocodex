import assert from "node:assert/strict";
import test from "node:test";

import {
  createGhCompatibilityCommand,
} from "../tools/browser/browserShell.mjs";
import { createBrowserEgressFetch } from "../tools/browser/browserEgress.mjs";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

test("browser egress sends one credential-free thread-scoped envelope", async () => {
  const requests = [];
  const fetch = createBrowserEgressFetch({
    origin: "https://nanocodex.example",
    threadId: THREAD_ID,
    async fetch(input, init) {
      requests.push(new Request(input, init));
      return new Response("drive", { status: 200 });
    },
  });

  const result = await fetch("https://www.googleapis.com/drive/v3/files?pageSize=1", {
    headers: { accept: "application/json" },
  });
  assert.equal(new TextDecoder().decode(result.body), "drive");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://nanocodex.example/v1/egress");
  assert.equal(requests[0].headers.get("authorization"), null);
  assert.deepEqual(await requests[0].json(), {
    thread_id: THREAD_ID,
    url: "https://www.googleapis.com/drive/v3/files?pageSize=1",
    method: "GET",
    headers: { accept: "application/json" },
  });
});

test("browser gh makes useful GitHub calls through the same-origin connector", async () => {
  const requests = [];
  const command = createGhCompatibilityCommand({}, {}, (_name, handler) => handler, {
    async fetch(url, init) {
      requests.push({
        authorization: new Headers(init.headers).get("authorization"),
        body: init.body,
        method: init.method,
        url,
      });
      if (url === "https://api.github.com/user") return secureJson(url, { login: "nano-cat" });
      if (url === "https://api.github.com/repos/gakonst/nanocodex") return secureJson(url, {
        default_branch: "master",
        description: "Tiny agents",
        full_name: "gakonst/nanocodex",
        html_url: "https://github.com/gakonst/nanocodex",
        private: false,
      });
      if (url.includes("/pulls?")) return secureJson(url, [{
        number: 42,
        title: "Keep credentials private",
        head: { ref: "connector" },
      }]);
      return secureJson(url, { full_name: "gakonst/nanocodex" });
    },
  });

  const auth = await command(["auth", "status"]);
  assert.equal(auth.exitCode, 0);
  assert.match(auth.stdout, /nano-cat/);
  const api = await command(["api", "repos/gakonst/nanocodex"]);
  assert.match(api.stdout, /gakonst\/nanocodex/);
  const repo = await command(["repo", "view", "gakonst/nanocodex"]);
  assert.match(repo.stdout, /default branch:\tmaster/);
  const pulls = await command(["pr", "list", "--repo", "gakonst/nanocodex", "--limit", "10"]);
  assert.equal(pulls.stdout, "42\tKeep credentials private\tconnector\n");

  assert.equal(requests.length, 4);
  assert(requests.every(({ url }) => url.startsWith("https://api.github.com/")));
  assert(requests.every(({ method }) => method === "GET"));
  assert(requests.every(({ authorization }) => authorization === null));
  assert.match(requests[3].url, /per_page=10/);
  const write = await command([
    "api", "--method", "POST", "/repos/gakonst/nanocodex/issues", "-f", "title=hello",
  ]);
  assert.equal(write.exitCode, 0);
  assert.equal(requests[4].method, "POST");
  assert.equal(requests[4].body, JSON.stringify({ title: "hello" }));
  assert.equal(requests[4].authorization, null);
});

function secureJson(url, value) {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(value)),
    url,
  };
}
