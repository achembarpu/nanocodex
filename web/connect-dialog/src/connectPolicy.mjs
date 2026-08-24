export const productionConnectApiOrigin = "https://nanocodex-connect-api.gakonst.workers.dev";

const productionApps = new Map([
  ["https://nanocodex-connect-playground.gakonst.workers.dev", Object.freeze({
    id: "atlas-workspace",
    name: "Atlas Workspace",
    origin: "https://nanocodex-connect-playground.gakonst.workers.dev",
  })],
]);

export function registeredApp(embeddingOrigin, dialogOrigin) {
  const registered = productionApps.get(embeddingOrigin);
  if (registered) return registered;
  if (isLoopbackOrigin(dialogOrigin) && isLoopbackOrigin(embeddingOrigin)) {
    return Object.freeze({ id: "atlas-workspace", name: "Atlas Workspace", origin: embeddingOrigin });
  }
  throw new Error("This application is not registered with Nanocodex Connect.");
}

export function connectApiOrigin(auth, dialogOrigin) {
  const configured = authEndpoints(auth);
  if (configured.length === 0) {
    throw new Error("Nanocodex Connect has no account broker URL.");
  }
  const origins = configured.map(endpointOrigin);
  if (origins.every((origin) => origin === productionConnectApiOrigin)) {
    return productionConnectApiOrigin;
  }
  if (isLoopbackOrigin(dialogOrigin)) {
    const expected = origins[0];
    if (!isLoopbackOrigin(expected) || origins.some((origin) => origin !== expected)) {
      throw new Error("Local Nanocodex Connect auth endpoints must share one loopback origin.");
    }
    return expected;
  }
  throw new Error("Nanocodex Connect auth endpoints must use the production Connect API.");
}

export function sanitizeWalletResult(result) {
  if (!isRecord(result) || !Array.isArray(result.accounts)) {
    throw new Error("Accounts did not return a connected account.");
  }
  return {
    ...result,
    accounts: result.accounts.map((value) => {
      if (!isRecord(value)) throw new Error("Accounts returned an invalid connected account.");
      const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
      const auth = isRecord(capabilities.auth) ? capabilities.auth : {};
      if (typeof auth.approval_id !== "string" || auth.approval_id.length === 0) {
        throw new Error("Accounts did not return a signed approval identifier.");
      }
      return {
        ...value,
        capabilities: {
          ...capabilities,
          auth: { approval_id: auth.approval_id },
        },
      };
    }),
  };
}

export function isLoopbackOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value
      && (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function authEndpoints(auth) {
  if (typeof auth === "string") return [auth];
  if (!isRecord(auth)) return [];
  const endpoints = [];
  for (const name of ["challenge", "url", "verify", "logout"]) {
    if (!(name in auth)) continue;
    if (typeof auth[name] !== "string") {
      throw new Error(`Nanocodex Connect auth ${name} must be a URL.`);
    }
    endpoints.push(auth[name]);
  }
  return endpoints;
}

function endpointOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Nanocodex Connect received an invalid auth endpoint.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Nanocodex Connect received an unsafe auth endpoint.");
  }
  return url.origin;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
