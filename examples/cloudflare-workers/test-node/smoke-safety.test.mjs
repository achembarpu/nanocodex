import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  isMissingWorkerDeleteError,
  runBoundedProcess,
  spawnProcessGroup,
} from "../scripts/child-process.mjs";
import { deleteWith503Retry } from "../scripts/cleanup-resource.mjs";
import {
  credentialSafeHttpOrigin,
  credentialSafeUrl,
} from "../scripts/credential-origin.mjs";
import { envLine } from "../scripts/env-file.mjs";

test("brokered dev writes structured credentials as one JSON layer", () => {
  const bootstrap = {
    access_token: "fixture-access-token",
    account_id: "fixture-account",
    expires_at: 123,
    fedramp: false,
  };
  const bootstrapLine = envLine("CODEX_OAUTH_BOOTSTRAP", bootstrap);
  const encodedBootstrap = bootstrapLine.slice(bootstrapLine.indexOf("=") + 1);
  assert.equal(encodedBootstrap[0], "{");
  assert.deepEqual(JSON.parse(encodedBootstrap), bootstrap);

  const encodedString = envLine("OPENAI_API_KEY", "fixture-key").split("=", 2)[1];
  assert.equal(JSON.parse(encodedString), "fixture-key");
});

test("brokered dev keeps its disposable state root under launcher control", async () => {
  const script = fileURLToPath(new URL("../scripts/dev-brokered.mjs", import.meta.url));
  await assert.rejects(
    runBoundedProcess(process.execPath, [script, "--persist-to", "/tmp/untrusted-state"], {
      label: "brokered dev state override",
      timeoutMs: 2_000,
    }),
    /--persist-to is controlled by the brokered development launcher/,
  );
});

test("credential-bearing URLs require TLS away from loopback", () => {
  for (const value of [
    "https://worker.example",
    "wss://worker.example/socket",
    "http://localhost:8787",
    "http://127.0.0.42:8787",
    "http://[::1]:8787",
    "ws://127.0.0.1:8787/socket",
  ]) {
    assert.doesNotThrow(() => credentialSafeUrl(value, "test endpoint"));
  }
  for (const value of [
    "http://worker.example",
    "ws://10.0.0.8/socket",
  ]) {
    assert.throws(
      () => credentialSafeUrl(value, "test endpoint"),
      /must use TLS unless its hostname is loopback/,
    );
  }
});

test("credential URL validation never reflects embedded credentials", () => {
  const secret = "origin-secret-that-must-not-be-logged";
  assert.throws(
    () => credentialSafeUrl(`https://${secret}@worker.example`, "test endpoint"),
    (error) => {
      assert.match(error.message, /must not contain URL credentials/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.throws(
    () => credentialSafeUrl(`not-a-url-${secret}`, "test endpoint"),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("credential-bearing Worker configuration is an origin", () => {
  assert.equal(credentialSafeHttpOrigin("https://worker.example").origin, "https://worker.example");
  assert.throws(() => credentialSafeHttpOrigin("https://worker.example/path"), /must be an HTTP\(S\) origin/);
  assert.throws(() => credentialSafeHttpOrigin("http://worker.example"), /must use TLS/);
});

test("multiplayer, live, managed, and REPL entrypoints reject cleartext remote origins", async () => {
  const secret = "entrypoint-admin-secret";
  const environment = {
    ...process.env,
    NANOCODEX_ADMIN_TOKEN: secret,
    NANOCODEX_ROOM_ALLOCATOR_TOKEN: secret,
    NANOCODEX_WORKER_URL: "http://worker.example",
  };
  const scripts = [
    "multiplayer-smoke.mjs",
    "managed-api-smoke.mjs",
    "live-smoke.mjs",
    "repl.mjs",
  ];
  await Promise.all(scripts.map(async (script) => {
    const path = fileURLToPath(new URL(`../scripts/${script}`, import.meta.url));
    await assert.rejects(
      runBoundedProcess(process.execPath, [path], {
        env: environment,
        label: script,
        timeoutMs: 2_000,
      }),
      (error) => {
        assert.match(error.message, /must use TLS unless its hostname is loopback/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  }));
});

test("multiplayer smoke reaches its RoomClient after async room setup", async () => {
  const requests = [];
  const roomId = "entrypoint-room";
  const invite = "entrypoint-invite";
  let origin;
  let member = 0;
  const server = createServer((request, response) => {
    request.resume();
    const url = new URL(request.url, origin);
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "POST" && url.pathname === "/v1/rooms") {
      sendJson(response, 201, {
        room_id: roomId,
        member_id: "owner",
        websocket_url: `${origin.replace("http:", "ws:")}/v1/rooms/${roomId}/socket`,
        auth_mode: "api_key",
        invite,
        invite_url: `${origin}/multiplayer?room=${roomId}#invite=${invite}`,
      }, "entrypoint=owner");
      return;
    }
    if (request.method === "POST" && url.pathname === `/v1/rooms/${roomId}/join`) {
      member += 1;
      sendJson(response, 201, {
        room_id: roomId,
        member_id: `guest-${member}`,
        websocket_url: `${origin.replace("http:", "ws:")}/v1/rooms/${roomId}/socket`,
        auth_mode: "api_key",
      }, `entrypoint=guest-${member}`);
      return;
    }
    if (request.method === "DELETE" && url.pathname === `/v1/rooms/${roomId}`) {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    requests.push(`UPGRADE ${new URL(request.url, origin).pathname}`);
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  try {
    await listenLoopback(server);
    const address = server.address();
    origin = `http://127.0.0.1:${address.port}`;
    const script = fileURLToPath(new URL("../scripts/multiplayer-smoke.mjs", import.meta.url));
    await assert.rejects(
      runBoundedProcess(process.execPath, [script], {
        env: {
          ...process.env,
          NANOCODEX_WORKER_URL: origin,
          NANOCODEX_MULTIPLAYER_TIMEOUT_MS: "1000",
          NANOCODEX_SMOKE_CLEANUP_TIMEOUT_MS: "1000",
        },
        label: "multiplayer entrypoint fixture",
        timeoutMs: 5_000,
      }),
      (error) => {
        assert.match(error.message, /Unexpected server response: 503/);
        assert.doesNotMatch(error.message, /Cannot access 'RoomClient' before initialization/);
        return true;
      },
    );
    assert.deepEqual(requests, [
      "POST /v1/rooms",
      `POST /v1/rooms/${roomId}/join`,
      `POST /v1/rooms/${roomId}/join`,
      `UPGRADE /v1/rooms/${roomId}/socket`,
      `DELETE /v1/rooms/${roomId}`,
    ]);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("cleanup retries only 503 and succeeds after deletion", async () => {
  const statuses = [503, 503, 204];
  const observedSignals = [];
  const result = await deleteWith503Retry((signal) => {
    observedSignals.push(signal);
    return new Response(null, { status: statuses.shift() });
  }, { description: "fixture cleanup", retryDelayMs: 1, timeoutMs: 1_000 });
  assert.deepEqual(result, { attempts: 3, status: 204 });
  assert.equal(observedSignals.length, 3);
  assert(observedSignals.every((signal) => signal instanceof AbortSignal));
});

test("cleanup treats not-found as already clean and rejects unexpected responses", async () => {
  assert.deepEqual(
    await deleteWith503Retry(
      async () => new Response(null, { status: 404 }),
      { description: "fixture cleanup", retryDelayMs: 1, timeoutMs: 100 },
    ),
    { attempts: 1, status: 404 },
  );
  await assert.rejects(
    deleteWith503Retry(
      async () => new Response(null, { status: 500 }),
      { description: "fixture cleanup", retryDelayMs: 1, timeoutMs: 100 },
    ),
    /fixture cleanup returned unexpected HTTP 500/,
  );
});

test("cleanup bounds a hung request", async () => {
  const startedAt = performance.now();
  await assert.rejects(
    deleteWith503Retry(
      async () => new Promise(() => {}),
      { description: "hung cleanup", retryDelayMs: 1, timeoutMs: 25 },
    ),
    /hung cleanup exceeded its bounded deadline/,
  );
  assert(performance.now() - startedAt < 1_000);
});

test("cleanup stops retrying persistent 503 responses at its deadline", async () => {
  let attempts = 0;
  await assert.rejects(
    deleteWith503Retry(
      async () => {
        attempts += 1;
        return new Response(null, { status: 503 });
      },
      { description: "unavailable cleanup", retryDelayMs: 2, timeoutMs: 25 },
    ),
    /unavailable cleanup remained unavailable \(HTTP 503\) for 25ms/,
  );
  assert(attempts > 1);
});

test("Wrangler missing-worker detection is narrow", () => {
  assert.equal(
    isMissingWorkerDeleteError(new Error("The Worker script 'disposable' was not found [code: 10090]")),
    true,
  );
  assert.equal(isMissingWorkerDeleteError(new Error("workers.api.error.script_not_found")), true);
  assert.equal(isMissingWorkerDeleteError(new Error("authentication token not found")), false);
  assert.equal(
    isMissingWorkerDeleteError(new Error("Worker deletion failed: authentication token not found")),
    false,
  );
  assert.equal(isMissingWorkerDeleteError(new Error("Wrangler timed out")), false);
});

test("bounded child processes terminate their process group", {
  skip: process.platform === "win32",
}, async () => {
  const pidPath = join(tmpdir(), `nanocodex-child-${process.pid}-${Date.now()}.pid`);
  const fixture = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'child.unref();',
    'writeFileSync(process.argv[1], String(child.pid));',
    'setInterval(() => {}, 1000);',
  ].join("\n");
  try {
    await assert.rejects(
      runBoundedProcess(process.execPath, ["-e", fixture, pidPath], {
        label: "process-group fixture",
        terminationGraceMs: 100,
        timeoutMs: 500,
      }),
      /process-group fixture timed out after 500ms/,
    );
    const descendantPid = Number(await readFile(pidPath, "utf8"));
    assert(Number.isSafeInteger(descendantPid) && descendantPid > 1);
    await waitForProcessExit(descendantPid);
  } finally {
    await rm(pidPath, { force: true });
  }
});

test("bounded child diagnostics apply caller redaction", async () => {
  const secret = "child-secret-do-not-print";
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(secret)}); process.exit(7)`], {
      label: "redaction fixture",
      redact: (value) => value.replaceAll(secret, "[redacted]"),
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("explicit termination removes descendants after their direct leader exits", {
  skip: process.platform === "win32",
}, async () => {
  const pidPath = join(tmpdir(), `nanocodex-orphan-${process.pid}-${Date.now()}.pid`);
  const descendant = [
    'process.on("SIGTERM", () => {});',
    'process.send(String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join(" ");
  const fixture = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });`,
    'child.once("message", (pid) => { writeFileSync(process.argv[1], pid); child.disconnect(); child.unref(); });',
  ].join("\n");
  const handle = spawnProcessGroup(process.execPath, ["-e", fixture, pidPath], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    assert.equal((await handle.exit).code, 0);
    const descendantPid = Number(await readFile(pidPath, "utf8"));
    assert.equal(processIsAlive(descendantPid), true);
    await handle.terminate(100);
    await waitForProcessExit(descendantPid);
  } finally {
    await handle.terminate(100).catch(() => {});
    await rm(pidPath, { force: true });
  }
});

async function waitForProcessExit(pid) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`descendant process ${pid} survived process-group termination`);
}

function listenLoopback(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function sendJson(response, status, value, cookie) {
  response.writeHead(status, {
    "content-type": "application/json",
    "set-cookie": `${cookie}; Path=/; HttpOnly; SameSite=Strict`,
  });
  response.end(JSON.stringify(value));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
