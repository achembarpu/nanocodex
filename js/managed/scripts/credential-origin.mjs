import { isIP } from "node:net";

const SECURE_PROTOCOLS = new Set(["https:", "wss:"]);
const CLEARTEXT_PROTOCOLS = new Set(["http:", "ws:"]);

export function credentialSafeUrl(input, label = "credential-bearing URL") {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) or WebSocket URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain URL credentials`);
  }
  if (!SECURE_PROTOCOLS.has(url.protocol) && !CLEARTEXT_PROTOCOLS.has(url.protocol)) {
    throw new Error(`${label} must use HTTP(S) or WebSocket transport`);
  }
  if (CLEARTEXT_PROTOCOLS.has(url.protocol) && !isLoopbackHostname(url.hostname)) {
    throw new Error(`${label} must use TLS unless its hostname is loopback`);
  }
  return url;
}

export function credentialSafeHttpOrigin(input, label = "credential-bearing origin") {
  const url = credentialSafeUrl(input, label);
  if (!new Set(["http:", "https:"]).has(url.protocol)
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new Error(`${label} must be an HTTP(S) origin without a path, query, or fragment`);
  }
  return url;
}

export function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".", 1)[0] === "127";
}
