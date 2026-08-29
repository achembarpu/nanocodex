import { randomBytes } from "node:crypto";

import { Base64, P256, PublicKey, WebAuthnP256 } from "ox";

const API_KEY = /^ncx_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_COOKIE = /^nanocodex_account=[0-9a-f]{64}$/;

export async function resolveManagedSmokeCredentials(baseUrl, label, environment = process.env) {
  const url = new URL(baseUrl);
  const apiKey = environment.NANOCODEX_API_KEY?.trim();
  const accountCookie = environment.NANOCODEX_ACCOUNT_COOKIE?.trim();
  if (apiKey || accountCookie) {
    if (!API_KEY.test(apiKey ?? "") || !ACCOUNT_COOKIE.test(accountCookie ?? "")) {
      throw new Error(
        "NANOCODEX_API_KEY and NANOCODEX_ACCOUNT_COOKIE must both identify the same passkey-backed account",
      );
    }
    return { apiKey, accountCookie, temporary: false, cleanup: async () => {} };
  }
  if (!localSmokeOrigin(url)) {
    throw new Error(
      "remote WebSocket smoke requires explicit NANOCODEX_API_KEY and NANOCODEX_ACCOUNT_COOKIE",
    );
  }
  return createLocalSmokeAccount(url, label);
}

export async function createLocalSmokeAccount(baseUrl, label) {
  const url = new URL(baseUrl);
  if (!localSmokeOrigin(url)) throw new Error("local smoke account creation is loopback-only");

  const bootstrap = await fetch(new URL("/v1/me", url));
  if (!bootstrap.ok) throw new Error(`local account bootstrap failed with HTTP ${bootstrap.status}`);
  const anonymousCookie = responseAccountCookie(bootstrap);
  const account = await bootstrap.json();
  if (!anonymousCookie || account?.user?.persistent !== false) {
    throw new Error("local account bootstrap did not return one anonymous browser account");
  }

  const optionsResponse = await fetch(new URL("/webauthn/register/options", url), {
    method: "POST",
    headers: {
      cookie: anonymousCookie,
      "content-type": "application/json",
      origin: url.origin,
    },
    body: "{}",
  });
  if (!optionsResponse.ok) {
    throw new Error(`local passkey options failed with HTTP ${optionsResponse.status}`);
  }
  const options = await optionsResponse.json();
  const publicKeyOptions = options?.options?.publicKey;
  if (typeof publicKeyOptions?.challenge !== "string"
    || typeof publicKeyOptions?.rp?.id !== "string") {
    throw new Error("local passkey options returned an invalid challenge or RP ID");
  }

  const credentialId = randomBytes(32);
  const { publicKey } = P256.createKeyPair();
  const clientDataJSON = WebAuthnP256.getClientDataJSON({
    challenge: publicKeyOptions.challenge,
    origin: url.origin,
    type: "webauthn.create",
  });
  const authData = WebAuthnP256.getAuthenticatorData({
    credential: { id: credentialId, publicKey },
    flag: 0x45,
    rpId: publicKeyOptions.rp.id,
  });
  const attestationObject = WebAuthnP256.getAttestationObject({ authData });
  const id = Base64.fromBytes(credentialId, { pad: false, url: true });
  const encodedClientData = Base64.fromBytes(new TextEncoder().encode(clientDataJSON), {
    pad: false,
    url: true,
  });
  const encodedAttestation = Base64.fromHex(attestationObject, { pad: false, url: true });
  const registration = await fetch(new URL("/webauthn/register", url), {
    method: "POST",
    headers: {
      cookie: anonymousCookie,
      "content-type": "application/json",
      origin: url.origin,
    },
    body: JSON.stringify({
      attestationObject: encodedAttestation,
      clientDataJSON: encodedClientData,
      id,
      publicKey: PublicKey.toHex(publicKey),
      raw: {
        authenticatorAttachment: null,
        id,
        rawId: id,
        response: {
          attestationObject: encodedAttestation,
          clientDataJSON: encodedClientData,
        },
        type: "public-key",
      },
    }),
  });
  if (!registration.ok) {
    throw new Error(`local passkey registration failed with HTTP ${registration.status}: ${await registration.text()}`);
  }
  const accountCookie = responseAccountCookie(registration);
  await registration.body?.cancel();
  if (!accountCookie || !ACCOUNT_COOKIE.test(accountCookie)) {
    throw new Error("local passkey registration returned no persistent account cookie");
  }

  const claim = await fetch(new URL("/v1/credentials/local-claim", url), {
    method: "POST",
    headers: { cookie: accountCookie, origin: url.origin },
  });
  if (!claim.ok) throw new Error(`local credential claim failed with HTTP ${claim.status}`);
  await claim.body?.cancel();

  const created = await fetch(new URL("/v1/api-keys", url), {
    method: "POST",
    headers: {
      cookie: accountCookie,
      "content-type": "application/json",
      origin: url.origin,
    },
    body: JSON.stringify({ label }),
  });
  if (created.status !== 201) {
    throw new Error(`local API key creation failed with HTTP ${created.status}`);
  }
  const value = await created.json();
  if (!API_KEY.test(value?.api_key) || typeof value?.key?.id !== "string") {
    throw new Error("local API key creation returned an invalid key");
  }

  let cleaned = false;
  return {
    apiKey: value.api_key,
    accountCookie,
    temporary: true,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      const response = await fetch(new URL(`/v1/api-keys/${value.key.id}`, url), {
        method: "DELETE",
        headers: { cookie: accountCookie, origin: url.origin },
      });
      if (response.status !== 204 && response.status !== 404) {
        throw new Error(`local API key cleanup failed with HTTP ${response.status}`);
      }
      await response.body?.cancel();
    },
  };
}

function responseAccountCookie(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const cookie = value.split(";", 1)[0];
    if (cookie.startsWith("nanocodex_account=")) return cookie;
  }
  return undefined;
}

function localSmokeOrigin(url) {
  return ["http:", "https:"].includes(url.protocol)
    && (url.hostname === "127.0.0.1"
      || url.hostname === "::1"
      || url.hostname === "localhost"
      || url.hostname === "nanocodex.localhost"
      || url.hostname.endsWith(".nanocodex.localhost"));
}
