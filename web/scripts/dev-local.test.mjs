import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  localDevelopmentOrigin,
  localConnectorEnvironment,
  localDependencyRequirements,
  localStackChildOptions,
  loadRootEnvironment,
  managedChildEnvironment,
  parseLocalDevOptions,
  providerFreeWebEnvironment,
  rejectWorkerEnvironmentFiles,
  resolveLocalAuthMode,
  stopLocalStackChildren,
  terminateLocalStackChild,
  verifyLocalGitAdvertisement,
  verifyLocalHealthResponse,
  verifyLocalModelPreconnect,
  verifyLocalState,
  verifyLocalMultiplayer,
  viteChildConfiguration,
  waitForManagedStack,
  websiteChildLaunch,
} from "./dev-local.mjs";
import { prepareDevWasm } from "./check-dev-wasm.mjs";

const execFileAsync = promisify(execFile);
const devLocalScript = fileURLToPath(new URL("./dev-local.mjs", import.meta.url));

test("local development installs every package required to start the web stack", () => {
  const requirements = localDependencyRequirements();
  const web = requirements.find(({ root }) => basename(root) === "web");
  assert.ok(web);
  assert.deepEqual(web.requiredFiles, [
    "node_modules/accounts/package.json",
    "node_modules/wrangler/bin/wrangler.js",
  ]);
  assert.equal(requirements.length, 3);
});

test("local web environment cannot inherit provider or Cloudflare deployment credentials", () => {
  const environment = providerFreeWebEnvironment({
    PATH: "/bin",
    OPENAI_API_KEY: "provider-secret",
    CODEX_OAUTH_BOOTSTRAP: "oauth-secret",
    CHATGPT_REFRESH_TOKEN: "refresh-secret",
    CLOUDFLARE_API_TOKEN: "deployment-secret",
    UNLISTED_SECRET_SENTINEL: "unknown-secret",
    GIT_MIRROR_TOKEN: "ephemeral-local-token",
  });

  assert.deepEqual(environment, {
    PATH: "/bin",
    GIT_MIRROR_TOKEN: "ephemeral-local-token",
  });
});

test("local connector app credentials use private auxiliary names", () => {
  assert.deepEqual(localConnectorEnvironment({
    GH_CLIENT_ID: "github-client",
    GH_CLIENT_SECRETS: "github-secret",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    OPENAI_API_KEY: "must-not-project",
  }), {
    NANOCODEX_LOCAL_GITHUB_OAUTH_CLIENT_ID: "github-client",
    NANOCODEX_LOCAL_GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
    NANOCODEX_LOCAL_GOOGLE_OAUTH_CLIENT_ID: "google-client",
    NANOCODEX_LOCAL_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
  });
});

test("the orchestrator loads one root env source before auth selection", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-root-env-"));
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousMode = process.env.NANOCODEX_AUTH_MODE;
  const previousSentinel = process.env.NANOCODEX_ROOT_ENV_SENTINEL;
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.NANOCODEX_AUTH_MODE;
    delete process.env.NANOCODEX_ROOT_ENV_SENTINEL;
    const envPath = join(temporaryDirectory, ".env");
    await writeFile(
      envPath,
      "NANOCODEX_AUTH_MODE=api_key\nOPENAI_API_KEY=root-provider-secret\nNANOCODEX_ROOT_ENV_SENTINEL=loaded-once\n",
    );
    loadRootEnvironment(envPath);
    assert.equal(process.env.NANOCODEX_ROOT_ENV_SENTINEL, "loaded-once");
    const options = parseLocalDevOptions([], process.env);
    assert.equal(options.requestedMode, "api_key");
    assert.equal(await resolveLocalAuthMode(options, process.env), "api_key");
    assert.equal(managedChildEnvironment(process.env).OPENAI_API_KEY, "root-provider-secret");
    assert.equal(providerFreeWebEnvironment(process.env).OPENAI_API_KEY, undefined);
    assert.throws(() => loadRootEnvironment(envPath), /already loaded/);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousMode === undefined) delete process.env.NANOCODEX_AUTH_MODE;
    else process.env.NANOCODEX_AUTH_MODE = previousMode;
    if (previousSentinel === undefined) delete process.env.NANOCODEX_ROOT_ENV_SENTINEL;
    else process.env.NANOCODEX_ROOT_ENV_SENTINEL = previousSentinel;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the actual Vite child launch cannot inherit or reload a provider sentinel", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-env-sentinel-"));
  try {
    const envPath = join(temporaryDirectory, "child.env");
    await writeFile(envPath, "RELOADED_ENV_SECRET_SENTINEL=env-file-secret\n");
    const inherited = {
      ...process.env,
      GIT_MIRROR_TOKEN: "ephemeral-local-token",
      NODE_OPTIONS: `--env-file=${envPath}`,
      NANOCODEX_CODEX_AUTH_FILE: "/private/codex/auth.json",
      OPENAI_API_KEY: "provider-secret",
      ROOT_ENV_SECRET_SENTINEL: "root-secret",
    };
    const names = [
      "GIT_MIRROR_TOKEN",
      "NANOCODEX_CODEX_AUTH_FILE",
      "NANOCODEX_LOCAL_MODEL_ACCESS",
      "NANOCODEX_LOCAL_MODEL_AUTH_MODE",
      "OPENAI_API_KEY",
      "RELOADED_ENV_SECRET_SENTINEL",
      "ROOT_ENV_SECRET_SENTINEL",
    ];
    const websiteLaunch = websiteChildLaunch(inherited, localDevelopmentOrigin(), {
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      NANOCODEX_LOCAL_MODEL_ACCESS: "managed",
      NANOCODEX_LOCAL_MODEL_AUTH_MODE: "api_key",
    }, names);
    const websiteResult = await execFileAsync(
      websiteLaunch.command,
      websiteLaunch.arguments,
      { cwd: websiteLaunch.options.cwd, env: websiteLaunch.options.env },
    );
    assert.deepEqual(JSON.parse(websiteResult.stdout), {
      GIT_MIRROR_TOKEN: "ephemeral-local-token",
      NANOCODEX_CODEX_AUTH_FILE: null,
      NANOCODEX_LOCAL_MODEL_ACCESS: "managed",
      NANOCODEX_LOCAL_MODEL_AUTH_MODE: "api_key",
      OPENAI_API_KEY: null,
      RELOADED_ENV_SECRET_SENTINEL: null,
      ROOT_ENV_SECRET_SENTINEL: null,
    });

    const managedResult = await execFileAsync(
      process.execPath,
      [devLocalScript, "--environment-sentinel", ...names],
      { env: managedChildEnvironment(inherited) },
    );
    assert.deepEqual(JSON.parse(managedResult.stdout), {
      GIT_MIRROR_TOKEN: null,
      NANOCODEX_CODEX_AUTH_FILE: "/private/codex/auth.json",
      NANOCODEX_LOCAL_MODEL_ACCESS: null,
      NANOCODEX_LOCAL_MODEL_AUTH_MODE: null,
      OPENAI_API_KEY: "provider-secret",
      RELOADED_ENV_SECRET_SENTINEL: null,
      ROOT_ENV_SECRET_SENTINEL: null,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the Vite child disables env loading and rejects Wrangler dev-var files", async () => {
  assert.doesNotMatch(await readFile(devLocalScript, "utf8"), /--env-file(?:-if-exists)?/);
  assert.deepEqual(viteChildConfiguration("127.0.0.1", "5173"), {
    envDir: false,
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      watch: { ignored: ["**/.env*", "**/.dev.vars*"] },
    },
  });

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-dev-vars-"));
  try {
    await writeFile(join(temporaryDirectory, ".dev.vars"), "OPENAI_API_KEY=secret\n");
    await assert.rejects(
      rejectWorkerEnvironmentFiles(temporaryDirectory),
      /website Worker env files are disabled/,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("local stack children are isolated and shutdown still targets an exited group leader", async () => {
  assert.equal(localStackChildOptions({ stdio: "inherit" }, "linux").detached, true);
  assert.equal(localStackChildOptions({ stdio: "inherit" }, "win32").detached, false);
  const signals = [];
  const child = { exitCode: 0, pid: 42_424, signalCode: null };
  assert.equal(terminateLocalStackChild(
    child,
    "SIGTERM",
    (pid, signal) => { signals.push([pid, signal]); },
    "linux",
  ), true);
  assert.deepEqual(signals, [[-42_424, "SIGTERM"]]);

  signals.length = 0;
  let alive = true;
  await stopLocalStackChildren([child], [Promise.resolve()], {
    graceMs: 10,
    isAlive: () => alive,
    terminate: (target, signal) => {
      signals.push([target.pid, signal]);
      if (signal === "SIGKILL") alive = false;
    },
  });
  assert.deepEqual(signals, [[42_424, "SIGTERM"], [42_424, "SIGKILL"]]);
});

test("local stack shutdown kills a descendant after its process-group leader exits", {
  skip: process.platform === "win32",
}, async () => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
        const { spawn } = require("node:child_process");
        const descendant = spawn(
          process.execPath,
          ["--input-type=commonjs", "-e", "setInterval(() => {}, 1000)"],
          { stdio: "ignore" },
        );
        process.send({ pid: descendant.pid }, () => process.exit(0));
      `,
    ],
    localStackChildOptions({ stdio: ["ignore", "ignore", "inherit", "ipc"] }),
  );
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  void exited.catch(() => {});
  let descendantPid;
  let cleaned = false;
  try {
    descendantPid = await new Promise((resolvePid, rejectPid) => {
      const timeout = setTimeout(
        () => rejectPid(new Error("process-group fixture did not report its descendant")),
        1_000,
      );
      child.once("message", (message) => {
        clearTimeout(timeout);
        resolvePid(message.pid);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectPid(error);
      });
    });
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.doesNotThrow(() => process.kill(descendantPid, 0));

    await stopLocalStackChildren([child], [exited], { graceMs: 100 });
    let descendantExited = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
        descendantExited = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(descendantExited, true);
    cleaned = true;
  } finally {
    if (!cleaned && Number.isSafeInteger(child.pid)) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
      }
    }
    if (!cleaned && Number.isSafeInteger(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
});

test("managed local readiness is an exact private child-process attestation", async () => {
  const child = spawn(
    process.execPath,
    [devLocalScript, "--managed-ready-sentinel"],
    {
      env: providerFreeWebEnvironment(process.env),
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  await waitForManagedStack(child, 1_000);
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("local development options select one explicit managed auth mode", () => {
  assert.deepEqual(parseLocalDevOptions([], {}), {
    requestedMode: undefined,
    withoutMultiplayer: false,
  });
  assert.deepEqual(parseLocalDevOptions(["--auth-mode=api_key"], {}), {
    requestedMode: "api_key",
    withoutMultiplayer: false,
  });
  assert.deepEqual(parseLocalDevOptions(
    ["--without-multiplayer"],
    { NANOCODEX_AUTH_MODE: "chatgpt" },
  ), {
    requestedMode: undefined,
    withoutMultiplayer: true,
  });
  assert.throws(
    () => parseLocalDevOptions(["--without-multiplayer", "--auth-mode=chatgpt"], {}),
    /cannot be combined/,
  );
  assert.throws(
    () => parseLocalDevOptions(["--auth-mode=chatgpt", "--auth-mode=api_key"], {}),
    /only once/,
  );
  assert.throws(() => parseLocalDevOptions(["--auth-mode=other"], {}), /must be api_key/);
});

test("localhost selects only an existing non-interactive model credential", async () => {
  const automatic = { requestedMode: undefined, withoutMultiplayer: false };
  let inspectedLogin = false;
  assert.equal(
    await resolveLocalAuthMode(
      automatic,
      { OPENAI_API_KEY: "provider-secret" },
      async () => {
        inspectedLogin = true;
        return true;
      },
    ),
    "api_key",
  );
  assert.equal(inspectedLogin, false);
  assert.equal(
    await resolveLocalAuthMode(automatic, {}, async () => true),
    "chatgpt",
  );
  await assert.rejects(
    resolveLocalAuthMode(
      { requestedMode: "chatgpt", withoutMultiplayer: false },
      {},
      async () => false,
    ),
    /requires an existing 0600 Codex login/,
  );
  await assert.rejects(
    resolveLocalAuthMode(
      { requestedMode: "api_key", withoutMultiplayer: false },
      {},
      async () => true,
    ),
    /requires OPENAI_API_KEY/,
  );

  inspectedLogin = false;
  assert.equal(
    await resolveLocalAuthMode(
      { requestedMode: undefined, withoutMultiplayer: true },
      {},
      async () => {
        inspectedLogin = true;
        return true;
      },
    ),
    undefined,
  );
  assert.equal(inspectedLogin, false);
});

test("localhost auto-discovers the host Codex auth file without reading it into the website", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-codex-auth-"));
  try {
    const authPath = join(temporaryDirectory, "auth.json");
    const accessPayload = Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    })).toString("base64url");
    await writeFile(authPath, `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: `header.${accessPayload}.signature`,
        account_id: "account-1",
      },
    })}\n`, { mode: 0o600 });
    assert.equal(
      await resolveLocalAuthMode(
        { requestedMode: undefined, withoutMultiplayer: false },
        { NANOCODEX_CODEX_AUTH_FILE: authPath },
      ),
      "chatgpt",
    );
    assert.equal(
      providerFreeWebEnvironment({ NANOCODEX_CODEX_AUTH_FILE: authPath })
        .NANOCODEX_CODEX_AUTH_FILE,
      undefined,
    );
    await writeFile(authPath, "not a usable Codex login\n", { mode: 0o600 });
    await assert.rejects(
      resolveLocalAuthMode(
        { requestedMode: undefined, withoutMultiplayer: false },
        { NANOCODEX_CODEX_AUTH_FILE: authPath },
      ),
      /No existing local model credential/,
    );
    assert.equal(
      await resolveLocalAuthMode(
        { requestedMode: undefined, withoutMultiplayer: false },
        {
          NANOCODEX_CODEX_AUTH_FILE: authPath,
          OPENAI_API_KEY: "provider-secret",
        },
      ),
      "api_key",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("missing localhost credentials fail without launching a login flow", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-no-auth-"));
  try {
    await assert.rejects(
      resolveLocalAuthMode(
        { requestedMode: undefined, withoutMultiplayer: false },
        {
          NANOCODEX_CODEX_AUTH_FILE: join(temporaryDirectory, "missing-auth.json"),
          PATH: temporaryDirectory,
        },
      ),
      /No existing local model credential.*never starts an OAuth or device-code flow/,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("local development origin is the canonical loopback HTTP authority", () => {
  assert.equal(localDevelopmentOrigin().origin, "http://localhost:5173");
  assert.equal(localDevelopmentOrigin("http://127.0.0.1:6123").port, "6123");
  for (const invalid of [
    "https://localhost:5173",
    "http://0.0.0.0:5173",
    "http://127.0.0.1",
    "http://127.0.0.1:5173/path",
  ]) {
    assert.throws(() => localDevelopmentOrigin(invalid), /explicit loopback HTTP origin/);
  }
});

test("managed localhost requires exact non-interactive health and WebSocket attestations", async () => {
  assert.equal(await verifyLocalHealthResponse(Response.json({
    agent_configured: true,
    auth_mode: "chatgpt",
    credential_source: "managed",
    interactive_auth: false,
    status: "ok",
  }), "chatgpt"), true);
  await assert.rejects(
    verifyLocalHealthResponse(Response.json({
      agent_configured: true,
      auth_mode: "chatgpt",
      credential_source: "subscription",
      interactive_auth: true,
      status: "ok",
    }), "chatgpt"),
    /did not attest non-interactive managed chatgpt access/,
  );

  class AttestedWebSocket extends EventEmitter {
    static attestation = '{"type":"nanocodex.proxy.ready"}';
    static instances = [];
    readyState = 1;
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.closed = false;
      AttestedWebSocket.instances.push(this);
      queueMicrotask(() => this.emit(
        "message",
        Buffer.from(this.constructor.attestation),
        false,
      ));
    }
    close() { this.closed = true; }
  }
  const origin = localDevelopmentOrigin("http://127.0.0.1:55173");
  await verifyLocalModelPreconnect(origin, AttestedWebSocket, 1_000);
  const socket = AttestedWebSocket.instances[0];
  assert.equal(socket.url.origin, "ws://127.0.0.1:55173");
  assert.equal(socket.url.pathname, "/api/responses");
  assert.match(socket.url.searchParams.get("session_id"), /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(socket.options, {
    handshakeTimeout: 1_000,
    origin: origin.origin,
  });
  assert.equal(socket.closed, true);

  class InvalidWebSocket extends AttestedWebSocket {
    static attestation = '{"type":"nanocodex.proxy.ready","credential":"forbidden"}';
  }
  await assert.rejects(
    verifyLocalModelPreconnect(origin, InvalidWebSocket, 1_000),
    /invalid attestation/,
  );
});

test("local readiness proves pinned Source, commit, patch, eval, and Git state", async () => {
  const origin = localDevelopmentOrigin("http://127.0.0.1:55173");
  const head = "a".repeat(40);
  const blob = "b".repeat(40);
  const calls = [];
  const gitCalls = [];
  const repository = {
    branch: "master",
    commitPageSize: 32,
    head,
    indexedCommits: 1,
  };
  const generatedAt = "2026-08-23T00:00:00.000Z";
  const responses = new Map([
    [`/api/repository/snapshot?generation=${head}`, Response.json({
      generatedAt,
      repository,
      tree: [{
        path: "README.md",
        objectId: blob,
        contentUrl: `/api/repository/blob/${blob}`,
      }],
    }, { headers: { "x-repository-generation": head } })],
    [`/api/repository/commit-index?generation=${head}`, Response.json({
      generatedAt,
      hashes: [head],
      repository,
      scopeCounts: { all: 1, docs: 0, eval: 0, fix: 0, perf: 0 },
      version: 1,
    }, { headers: { "x-repository-generation": head } })],
    ["/api/evals", Response.json({ schemaVersion: 5, worksets: [] })],
    [`/api/repository/blob/${blob}`, new Response("# Nanocodex\n")],
    [`/api/repository/commits?generation=${head}&page=0`, Response.json(
      [{
        author: "Nanocodex",
        authoredAt: generatedAt,
        body: "",
        files: [],
        hash: head,
        parents: [],
        refs: ["HEAD -> master"],
        shortHash: head.slice(0, 7),
        stats: { additions: 0, deletions: 0, files: 0 },
        subject: "test commit",
      }],
      { headers: { "x-repository-generation": head } },
    )],
    [`/api/repository/commits/${head}/0000.diff`, new Response(
      `From ${head} Mon Sep 17 00:00:00 2001\n`,
      { headers: { "x-repository-generation": head } },
    )],
  ]);

  await verifyLocalState(origin, head, {
    environment: { PATH: "/bin" },
    request: async (url) => {
      const key = `${url.pathname}${url.search}`;
      calls.push(key);
      const response = responses.get(key);
      assert.ok(response, `unexpected readiness request ${key}`);
      return response;
    },
    verifyGit: async (...arguments_) => { gitCalls.push(arguments_); },
  });

  assert.deepEqual(calls, [
    `/api/repository/snapshot?generation=${head}`,
    `/api/repository/commit-index?generation=${head}`,
    "/api/evals",
    `/api/repository/blob/${blob}`,
    `/api/repository/commits?generation=${head}&page=0`,
    `/api/repository/commits/${head}/0000.diff`,
  ]);
  assert.deepEqual(gitCalls, [[
    origin,
    head,
    { PATH: "/bin" },
  ]]);
});

test("local Git readiness uses only the provider-free HTTP read advertisement", async () => {
  const origin = localDevelopmentOrigin("http://127.0.0.1:55173");
  const head = "a".repeat(40);
  const executions = [];
  const advertisement = [
    "ref: refs/heads/master\tHEAD",
    `${head}\tHEAD`,
    `${head}\trefs/heads/master`,
    "",
  ].join("\n");
  await verifyLocalGitAdvertisement(
    origin,
    head,
    { PATH: "/bin" },
    async (...arguments_) => {
      executions.push(arguments_);
      return advertisement;
    },
  );

  assert.equal(executions[0][0], "git");
  assert.deepEqual(executions[0][1].slice(-6), [
    "ls-remote",
    "--symref",
    "--exit-code",
    "http://127.0.0.1:55173/git",
    "HEAD",
    "refs/heads/master",
  ]);
  assert.ok(executions[0][1].includes("protocol.version=2"));
  assert.ok(executions[0][1].includes("credential.helper="));
  assert.equal(executions[0][1].some((argument) => argument.startsWith("http.sslCAInfo=")), false);
  assert.equal(executions[0][2].env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(executions[0][2].env.OPENAI_API_KEY, undefined);

  await assert.rejects(
    verifyLocalGitAdvertisement(
      origin,
      head,
      { PATH: "/bin" },
      async () => advertisement.replaceAll(head, "b".repeat(40)),
    ),
    /did not resolve the current HEAD/,
  );
});

test("development WASM preflight always delegates freshness to the canonical builder", async () => {
  const executions = [];
  let inspections = 0;
  await prepareDevWasm({
    execute: async (...arguments_) => { executions.push(arguments_); },
    inspect: async () => {
      inspections += 1;
      return [];
    },
    isExecutable: async () => true,
  });

  assert.equal(inspections, 2);
  assert.equal(executions.length, 1);
  assert.equal(executions[0][0], "just");
  assert.deepEqual(executions[0][1], ["build-wasm"]);
  assert.equal(
    executions[0][2],
    fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, ""),
  );
});

test("development WASM preflight invalidates partial output before repair", async () => {
  const executions = [];
  let executable = false;
  let inspections = 0;
  let invalidations = 0;
  await prepareDevWasm({
    execute: async (command, arguments_) => {
      executions.push([command, arguments_]);
      if (command === "npm") executable = true;
    },
    inspect: async () => {
      inspections += 1;
      return inspections === 1 ? ["nanocodex_bg.wasm (invalid)"] : [];
    },
    invalidate: async () => { invalidations += 1; },
    isExecutable: async () => executable,
  });

  assert.equal(invalidations, 1);
  assert.deepEqual(executions.map(([command]) => command), ["npm", "just"]);
});

test("development WASM preflight fails if canonical repair stays incomplete", async () => {
  await assert.rejects(
    prepareDevWasm({
      execute: async () => {},
      inspect: async () => ["nanocodex.d.ts"],
      invalidate: async () => {},
      isExecutable: async () => true,
    }),
    /remained incomplete: nanocodex\.d\.ts/,
  );
});

test("local readiness proves the real room lifecycle through the website boundary", async () => {
  const origin = localDevelopmentOrigin("http://127.0.0.1:55173");
  const roomId = `0198d214-0d9d-7a45-8a89-9c411950ab51~${"r".repeat(43)}`;
  const memberId = "0198d214-0d9d-7a45-8a89-9c411950ab52";
  const cookie = `nanocodex_room_${roomId.replaceAll("-", "")}=${"m".repeat(43)}`;
  const events = [];
  const responses = [
    Response.json({ auth_mode: "chatgpt", member_id: memberId, room_id: roomId }, {
      status: 201,
      headers: { "set-cookie": `${cookie}; Path=/v1/rooms; HttpOnly` },
    }),
    new Response(null, { status: 204 }),
  ];
  class ReadyRoomWebSocket extends EventEmitter {
    static instances = [];
    static readyFrame = {
      type: "ready",
      room_id: roomId,
      member_id: memberId,
      members: [{ id: memberId, name: "Local verifier" }],
      online_member_ids: [memberId],
      latest_cursor: "1",
      auth_mode: "chatgpt",
      can_target_agent: true,
      can_end_room: true,
    };
    readyState = 0;
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      ReadyRoomWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        events.push("socket_open");
        this.emit("open");
        this.emit(
          "message",
          Buffer.from(JSON.stringify(this.constructor.readyFrame)),
          false,
        );
      });
    }
    close(code, reason) {
      this.readyState = 3;
      this.closeArguments = [code, reason];
      events.push("socket_close");
      this.emit("close", code, Buffer.from(reason));
    }
    terminate() {
      this.readyState = 3;
      events.push("socket_terminate");
    }
  }
  const calls = [];
  await verifyLocalMultiplayer(origin, async (url, _signal, init) => {
    events.push(init?.method === "DELETE" ? "room_delete" : "room_create");
    calls.push({ url: url.href, ...init });
    return responses.shift();
  }, ReadyRoomWebSocket, 1_000);

  const createPayload = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(createPayload).sort(), ["create_id", "display_name"]);
  assert.equal(createPayload.display_name, "Local verifier");
  assert.match(createPayload.create_id, /^[A-Za-z0-9_-]{43}$/);
  const socket = ReadyRoomWebSocket.instances[0];
  assert.equal(
    socket.url.href,
    `ws://127.0.0.1:55173/v1/rooms/${roomId}/ws?cursor=0`,
  );
  assert.deepEqual(socket.options, {
    handshakeTimeout: 1_000,
    headers: { cookie },
    origin: origin.origin,
  });
  assert.deepEqual(socket.closeArguments, [1_000, "readiness_complete"]);
  assert.deepEqual(events, ["room_create", "socket_open", "socket_close", "room_delete"]);

  assert.deepEqual(calls.map(({ url, method, headers }) => ({ url, method, headers })), [
    {
      url: "http://127.0.0.1:55173/v1/rooms",
      method: "POST",
      headers: { "content-type": "application/json", origin: origin.origin },
    },
    {
      url: `http://127.0.0.1:55173/v1/rooms/${roomId}`,
      method: "DELETE",
      headers: { cookie },
    },
  ]);
});

test("local room readiness rejects a malformed ready frame but still deletes the probe room", async () => {
  const origin = localDevelopmentOrigin("http://localhost:55173");
  const roomId = `0198d214-0d9d-7a45-8a89-9c411950ab51~${"r".repeat(43)}`;
  const memberId = "0198d214-0d9d-7a45-8a89-9c411950ab52";
  const cookie = `nanocodex_room_${roomId.replaceAll("-", "")}=${"m".repeat(43)}`;
  const methods = [];
  class InvalidRoomWebSocket extends EventEmitter {
    readyState = 0;
    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
        this.emit("message", Buffer.from(JSON.stringify({
          type: "ready",
          room_id: roomId,
          member_id: memberId,
          members: [{ id: memberId, name: "Local verifier" }],
          online_member_ids: [memberId],
          latest_cursor: "1",
          auth_mode: "chatgpt",
          can_target_agent: true,
          can_end_room: true,
          unexpected: "field",
        })), false);
      });
    }
    close() { this.readyState = 3; }
    terminate() { this.readyState = 3; }
  }
  await assert.rejects(
    verifyLocalMultiplayer(
      origin,
      async (_url, _signal, init) => {
        methods.push(init?.method);
        if (init?.method === "POST") {
          return Response.json({ auth_mode: "chatgpt", member_id: memberId, room_id: roomId }, {
            status: 201,
            headers: { "set-cookie": `${cookie}; Path=/v1/rooms; HttpOnly` },
          });
        }
        return new Response(null, { status: 204 });
      },
      InvalidRoomWebSocket,
      1_000,
    ),
    /invalid ready frame/,
  );
  assert.deepEqual(methods, ["POST", "DELETE"]);
});
