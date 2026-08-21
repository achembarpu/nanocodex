import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { nanocodexTools } from "nanocodex/tools/vite";
import { createServer } from "vite";

const root = new URL("../", import.meta.url).pathname;
const driverPort = await availablePort();
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  optimizeDeps: { exclude: ["nanocodex"] },
  plugins: [nanocodexTools()],
  server: { host: "127.0.0.1", port: 0 },
  worker: { format: "es", plugins: () => [nanocodexTools()] },
});
const driver = spawn("safaridriver", ["--port", String(driverPort)], {
  stdio: ["ignore", "pipe", "pipe"],
});
let driverOutput = "";
driver.stdout.on("data", (chunk) => driverOutput += chunk);
driver.stderr.on("data", (chunk) => driverOutput += chunk);

let sessionId;
try {
  await vite.listen();
  await waitForDriver(driverPort, driver);
  const session = await webdriver(driverPort, "POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  });
  sessionId = session.sessionId;
  assert(sessionId, `safaridriver did not return a session: ${JSON.stringify(session)}`);
  const address = vite.httpServer.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/test/fixtures/browserCompatibility.html`;
  await webdriver(driverPort, "POST", `/session/${sessionId}/url`, { url });
  const deadline = Date.now() + 30_000;
  let result;
  while (Date.now() < deadline) {
    result = await webdriver(driverPort, "POST", `/session/${sessionId}/execute/sync`, {
      script: "return document.body.dataset.result || null",
      args: [],
    });
    if (typeof result === "string") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(typeof result, "string", "Safari smoke timed out before the Worker completed");
  const parsed = JSON.parse(result);
  assert.deepEqual(parsed, {
    ok: true,
    agent: "browser",
    gzip: "stable safari gzip\n",
    git: "?? input.txt\n?? input.txt.gz\n",
  });
  console.log(JSON.stringify({ safari: true, url, result: parsed }));
} catch (error) {
  const detail = driverOutput.trim();
  if (detail) error.message += `\nsafaridriver: ${detail}`;
  throw error;
} finally {
  if (sessionId) {
    await webdriver(driverPort, "DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  driver.kill("SIGTERM");
  await vite.close();
}

async function webdriver(port, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) {
    throw new Error(
      `WebDriver ${method} ${path} failed (${response.status}): ${JSON.stringify(payload.value ?? payload)}`,
    );
  }
  return payload.value;
}

async function waitForDriver(port, process) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`safaridriver exited with ${process.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) return;
    } catch {
      // The driver has not bound its loopback socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("safaridriver did not become ready");
}

async function availablePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
