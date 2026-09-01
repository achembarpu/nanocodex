import { nanocodex } from "../index.mjs";
import { nanocodex as nanocodexCloudflare } from "../cloudflare.mjs";
import {
  LOCAL_OAUTH_RELAY_ORIGIN,
  localOAuthRelayCallbackUrl,
  localOAuthRelayCallbackRedirect,
  signLocalOAuthRelayState,
} from "../oauth-relay.mjs";

const plugin = nanocodex({
  chatGpt: { responsesPath: "/api/responses" },
  oauthRelay: true,
});
plugin.resolveId("node-rsa");
await plugin.config({}, { command: "build" });

nanocodexCloudflare({
  chatGpt: false,
  cloudflare: {},
  oauthRelay: true,
});

const callback = localOAuthRelayCallbackUrl("github");
const state = await signLocalOAuthRelayState({
  provider: "github",
  targetOrigin: "http://account.nanocodex.localhost:4173",
  flow: "connect",
  state: "provider-state",
}, "development-secret");
await localOAuthRelayCallbackRedirect(
  new URL(`${LOCAL_OAUTH_RELAY_ORIGIN}/v1/connectors/github/callback?state=${state}`),
  "development-secret",
);
void callback;

// @ts-expect-error Cloudflare composition does not accept direct-Vite response paths.
nanocodexCloudflare({ chatGpt: { responsesPath: "/api/responses" } });
// @ts-expect-error Direct Vite integration has no Cloudflare configuration.
nanocodex({ cloudflare: {} });
