import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCAL_OAUTH_RELAY_HOST,
  LOCAL_OAUTH_RELAY_ORIGIN,
  LOCAL_OAUTH_RELAY_PORT,
  localOAuthRelayCallbackRedirect,
  localOAuthRelayChallengeProof,
} from "../localOAuthRelayEnvelope.mjs";

const RELAY_KEY_NAME = "NANOCODEX_LOCAL_OAUTH_RELAY_HMAC_KEY";

export function startLocalOAuthRelay({
  host = LOCAL_OAUTH_RELAY_HOST,
  port = LOCAL_OAUTH_RELAY_PORT,
  relayKey = process.env[RELAY_KEY_NAME],
} = {}) {
  if (host !== LOCAL_OAUTH_RELAY_HOST || port !== LOCAL_OAUTH_RELAY_PORT
    || typeof relayKey !== "string" || relayKey.length < 32) {
    throw new Error("invalid local OAuth relay configuration");
  }
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    if (typeof request.url !== "string") {
      json(response, 404, { error: "not_found" });
      return;
    }
    let url;
    try { url = new URL(request.url, LOCAL_OAUTH_RELAY_ORIGIN); } catch {
      json(response, 400, { error: "invalid_callback" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/oauth-callback-relay") {
      const challenge = url.searchParams.get("challenge");
      let proof;
      try { proof = await localOAuthRelayChallengeProof(challenge, relayKey); } catch {
        json(response, 400, { error: "invalid_challenge" });
        return;
      }
      json(response, 200, {
        service: "nanocodex-local-oauth-relay",
        status: "ok",
        version: 1,
        proof,
      });
      return;
    }
    if (request.method !== "GET") {
      json(response, 404, { error: "not_found" });
      return;
    }
    const destination = await localOAuthRelayCallbackRedirect(url, relayKey);
    if (!destination) {
      json(response, 400, { error: "invalid_callback" });
      return;
    }
    response.statusCode = 303;
    response.setHeader("location", destination.href);
    response.end();
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.listen(port, host);
  return server;
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = startLocalOAuthRelay();
  server.once("listening", () => {
    process.stderr.write(`Nanocodex local OAuth relay listening at ${LOCAL_OAUTH_RELAY_ORIGIN}.\n`);
  });
}
