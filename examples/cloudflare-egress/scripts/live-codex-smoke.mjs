import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_AUTH_FILE_BYTES = 64 * 1024;
const MIN_ACCESS_TOKEN_TTL_MS = 5 * 60_000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexRoot = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const authPath = resolve(process.env.NANOCODEX_CODEX_AUTH_FILE ?? join(codexRoot, "auth.json"));
const relayUrl = process.env.NANOCODEX_CODEX_RELAY_URL?.trim();
const agentToken = randomBytes(32).toString("base64url");
const suffix = randomBytes(8).toString("hex");
const brokerName = `nanocodex-egress-broker-smoke-${suffix}`;
const agentName = `nanocodex-egress-agent-smoke-${suffix}`;
const auth = await readCodexAccess(authPath);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "nanocodex-cloudflare-egress-"));
const brokerConfigPath = join(temporaryDirectory, "wrangler.broker.json");
const agentConfigPath = join(temporaryDirectory, "wrangler.agent.json");
const brokerSecretsPath = join(temporaryDirectory, "broker-secrets.json");
const agentSecretsPath = join(temporaryDirectory, "agent-secrets.json");
const bootstrap = JSON.stringify({
  access_token: auth.accessToken,
  account_id: auth.accountId,
  fedramp: auth.fedramp,
  expires_at: auth.expiresAt,
});

const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const diagnostics = [];
const deployedWorkers = [];
let successMessage;

try {
  await Promise.all([
    writeJson(brokerConfigPath, brokerConfig()),
    writeJson(agentConfigPath, agentConfig()),
    writeJson(brokerSecretsPath, {
      CODEX_OAUTH_BOOTSTRAP: bootstrap,
      ...(relayUrl ? { CODEX_RELAY_URL: relayUrl } : {}),
    }),
    writeJson(agentSecretsPath, { AGENT_TOKEN: agentToken }),
  ]);

  deployedWorkers.push(brokerName);
  const brokerOutput = await runWrangler([
    "deploy",
    "-c",
    brokerConfigPath,
    "--secrets-file",
    brokerSecretsPath,
  ]);
  diagnostics.push(brokerOutput);

  deployedWorkers.push(agentName);
  const agentOutput = await runWrangler([
    "deploy",
    "-c",
    agentConfigPath,
    "--secrets-file",
    agentSecretsPath,
  ]);
  diagnostics.push(agentOutput);
  const origin = agentOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (!origin) throw new Error("Wrangler did not report the managed-agent Worker URL");

  await waitUntilReady(`${origin}/health`);
  const unauthorized = await fetch(`${origin}/blocked`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (unauthorized.status !== 401) {
    throw new Error(`unauthenticated agent ingress returned HTTP ${unauthorized.status}, expected 401`);
  }

  const denied = await fetchJson(`${origin}/blocked`, {
    headers: { authorization: `Bearer ${agentToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (denied.response.status !== 403 || denied.body?.error !== "destination_denied") {
    throw new Error(
      `private broker deny check failed with HTTP ${denied.response.status}: ${JSON.stringify(denied.body)}`,
    );
  }

  const handshake = await fetchJson(`${origin}/codex-handshake`, {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!handshake.response.ok
    || handshake.body?.authenticated !== true
    || handshake.body?.upstream_status !== 101) {
    throw new Error(
      `Codex handshake failed with HTTP ${handshake.response.status}: ${JSON.stringify(handshake.body)}`,
    );
  }

  successMessage =
    "Standard Workers smoke passed and both disposable Workers were deleted: " +
    "the public agent used its private Service Binding, the broker denied an unmatched " +
    "destination, replaced both Codex placeholders, and opened the Responses WebSocket.\n";
} catch (error) {
  const detail = redact(diagnostics.join("").trim());
  throw new Error(`${errorMessage(error)}${detail ? `\nWrangler diagnostics:\n${detail}` : ""}`);
} finally {
  const cleanupFailures = [];
  for (const worker of deployedWorkers.reverse()) {
    try {
      await runWrangler(["delete", worker, "--force"]);
    } catch (error) {
      cleanupFailures.push(`${worker}: ${redact(errorMessage(error))}`);
    }
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (cleanupFailures.length > 0) {
    throw new Error(`Disposable Worker cleanup failed:\n${cleanupFailures.join("\n")}`);
  }
}

process.stdout.write(successMessage);

function brokerConfig() {
  return {
    name: brokerName,
    main: resolve(root, "src/egress.ts"),
    compatibility_date: "2026-07-29",
    compatibility_flags: ["global_fetch_strictly_public"],
    workers_dev: false,
    minify: true,
    vars: {
      AGENT_ID: "live-codex-smoke",
      ALLOWED_POLICIES: "codex",
    },
    durable_objects: {
      bindings: [{ name: "CODEX_OAUTH", class_name: "CodexOAuthBroker" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["CodexOAuthBroker"] }],
  };
}

function agentConfig() {
  return {
    name: agentName,
    main: resolve(root, "src/agent.ts"),
    compatibility_date: "2026-07-29",
    workers_dev: true,
    minify: true,
    services: [{ binding: "EGRESS", service: brokerName }],
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function runWrangler(arguments_) {
  return new Promise((resolveCommand, rejectCommand) => {
    const processHandle = spawn(process.execPath, [wrangler, ...arguments_], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    capture(processHandle, output);
    processHandle.once("error", rejectCommand);
    processHandle.once("exit", (code, signal) => {
      const detail = output.join("");
      if (code === 0) resolveCommand(detail);
      else rejectCommand(new Error(`Wrangler exited with ${code ?? signal}: ${redact(detail)}`));
    });
  });
}

function capture(processHandle, target) {
  for (const stream of [processHandle.stdout, processHandle.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      target.push(chunk);
      if (target.join("").length > 16 * 1024) target.shift();
    });
  }
}

function redact(value) {
  let redacted = value;
  for (const [secret, replacement] of [
    [auth.accessToken, "[redacted-access-token]"],
    [auth.accountId, "[redacted-account-id]"],
    [agentToken, "[redacted-agent-token]"],
    [relayUrl, "[redacted-relay-url]"],
  ]) {
    if (secret) redacted = redacted.replaceAll(secret, replacement);
  }
  return redacted;
}

async function readCodexAccess(path) {
  let file;
  try {
    file = await open(path, "r");
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Codex auth path is not a file");
    if (metadata.size > MAX_AUTH_FILE_BYTES) throw new Error("Codex auth file is too large");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("Codex auth file must not be accessible by group or other users");
    }
    const encoded = await file.readFile();
    const parsed = JSON.parse(encoded.toString("utf8"));
    if (!isRecord(parsed) || parsed.auth_mode !== "chatgpt" || !isRecord(parsed.tokens)) {
      throw new Error("Codex auth file does not contain a ChatGPT subscription login");
    }
    const accessToken = requiredString(parsed.tokens.access_token, "access token");
    const accessClaims = jwtPayload(accessToken);
    const idClaims = jwtPayload(optionalString(parsed.tokens.id_token));
    const authClaims = idClaims?.["https://api.openai.com/auth"];
    const accountId = optionalString(parsed.tokens.account_id)
      ?? (isRecord(authClaims) ? optionalString(authClaims.chatgpt_account_id) : undefined);
    if (!accountId) throw new Error("Codex auth file is missing the ChatGPT account ID");
    const expiresAt = typeof accessClaims?.exp === "number" ? accessClaims.exp * 1_000 : undefined;
    if (!expiresAt || expiresAt <= Date.now() + MIN_ACCESS_TOKEN_TTL_MS) {
      throw new Error("Codex access token expires too soon; run `codex login` and retry");
    }
    return {
      accessToken,
      accountId,
      fedramp: isRecord(authClaims) && authClaims.chatgpt_account_is_fedramp === true,
      expiresAt,
    };
  } finally {
    await file?.close();
  }
}

async function waitUntilReady(url) {
  let lastError;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const encoded = await readBoundedText(response, 4 * 1024);
      let body;
      try {
        body = JSON.parse(encoded);
      } catch {
        body = undefined;
      }
      if (response.ok && body?.status === "ok") return;
      lastError = new Error(
        `health check returned HTTP ${response.status} without the expected payload`,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Wrangler deployment did not become ready: ${errorMessage(lastError)}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const encoded = await readBoundedText(response, 16 * 1024);
  try {
    return { response, body: JSON.parse(encoded) };
  } catch {
    throw new Error(
      `${url} returned non-JSON HTTP ${response.status}: ${encoded.slice(0, 1_024)}`,
    );
  }
}

async function readBoundedText(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let decoded = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return decoded + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return decoded;
      }
      decoded += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function jwtPayload(token) {
  const encoded = token?.split(".")[1];
  if (!encoded) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function requiredString(value, name) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`Codex auth file is missing the ${name}`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
