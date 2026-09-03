import {
  Sandbox as CloudflareSandbox,
} from "@cloudflare/sandbox";

import { handleManagedEgress } from "./managed-egress";

export type SandboxRuntimeEnv = Readonly<{
  NANOCODEX: Fetcher;
}>;

/**
 * The account sandbox is untrusted execution. Public HTTP(S) is allowed only
 * after the managed egress policy has validated the request; every other
 * outbound protocol is denied by the container boundary.
 */
export class Sandbox extends CloudflareSandbox<SandboxRuntimeEnv> {
  override enableInternet = false;
  override interceptHttps = true;
}

export async function handleSandboxEgress(
  request: Request,
  env: SandboxRuntimeEnv,
): Promise<Response> {
  const headers = new Headers(request.headers);
  // The transparent container proxy reconstructs this from the intercepted
  // destination. It is transport metadata, not a caller-controlled credential,
  // and Request will derive the upstream Host header from the validated URL.
  headers.delete("host");
  const sanitized = new Request(request, { headers });
  // Shell traffic never receives account connector credentials. Those remain
  // available through the turn-scoped connector tools owned by the brain.
  return handleManagedEgress(sanitized, env.NANOCODEX, undefined, () => false);
}

Sandbox.outbound = handleSandboxEgress;

// Required by the Sandbox SDK for transparent HTTP(S) interception.
export { ContainerProxy } from "@cloudflare/sandbox";
