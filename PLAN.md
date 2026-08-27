# Hosted account and connector rollout

Updated: 2026-08-27

## Outcome

`nanocodex login` should establish a hosted Nanocodex account, authorize the CLI,
and take the browser directly to the connector call to action. That account is
the durable capability boundary: hosted memory, thread lookup, configured MCPs,
and future account tools become available to Nanocodex and Nanocodex2 without a
second client setup flow.

The website Account surface is the general case of the embeddable Connect
dialog. They share the same package, components, passkey chooser, connector
cards, and actions. The dialog adds only request-specific permission context,
filtering, authorization hooks, and return behavior.

## Product decisions

- Do not auto-import ChatGPT history for new accounts. Offer it as an optional
  connector/import action after account creation.
- Go directly from successful CLI authorization to the connector CTA instead of
  requiring an intermediate click.
- Show all remembered passkey accounts. Include a one-action current-passkey
  row, a separate “use another passkey” action, and a distinct create-account
  action.
- Signing out clears the session, not the remembered passkey/account list.
- An expired passkey-backed session asks the user to sign in again. It never
  silently creates or switches to an anonymous account.
- Connecting from the full Account surface updates the same page in place.
  Scoped Connect requests may render completion/return UI for the requesting
  client.
- Poll device authorization every second so a completed browser ceremony is
  reflected promptly in the CLI.
- Account entitlements are server-owned. Enabling memory or hosted tools for an
  account should require no new action in an already authenticated client.

## Completed

- Shared the Account and Connect identity/connection surface instead of keeping
  two visual implementations.
- Removed the one-account cap from both providers.
- Changed browser sign-out to preserve remembered passkey accounts.
- Added coverage for the shared surface, multiple remembered accounts, and
  sign-out behavior.
- Verified locally in a real browser that two virtual passkeys remain selectable
  after sign-out and reload.
- Pushed the implementation through `ad01c15dd2ce5b44955dde63bd05ec7558803365`
  to `origin/master`.
- Completed the nightly release for that commit; the release workflow publishes
  both `nanocodex` and `nanocodex2`, and the updater installs the companion
  binary.
- Performed the explicitly requested full Cloudflare reset: Workers, Durable
  Object namespaces, R2 data and buckets, D1 databases, AI Search, and Worker
  secrets were removed.
- Recreated empty production storage. The new eval D1 database ID is
  `d49546ff-8e8f-4e26-962a-c2cfbaa946f8` and is committed in Wrangler config.
- Directly deployed fresh Connect dialog, Connect playground, Connect API,
  managed agent, egress, and website Workers. The website deployment tagged to
  the commit is live at `https://nanocodex.gakonst.workers.dev`.

## Current production state

- Storage is intentionally fresh. No old user, passkey, connector, memory, or
  history records were restored.
- The website and its trigger are live. `/api/health` reports the expected
  deployment SHA.
- The reset deleted production secret values. The egress/broker OAuth secrets
  still need to be reseeded before hosted agents and provider connectors can be
  called fully configured. Never print those values while locating or applying
  them.
- The managed-agent deployment currently has a temporary generated admin secret;
  replace it from the canonical secret source as part of the final secret pass.
- CI is not part of this rollout. Continue with direct Wrangler deployments and
  browser evidence.

## Next actions

1. Build and directly deploy the complete root Worker configuration, including
   its configured container, from a clean worktree at the exact master commit.
2. Locate the canonical production secret source without exposing values. Reseed
   encryption/probe values and GitHub, Google, and optional X OAuth credentials,
   then redeploy the owning egress/broker and managed Workers.
3. Exercise the live `/connect` Account route in the host-managed browser:
   create a fresh passkey, sign out, sign back in, reload, and verify remembered
   account selection and the connector-card in-place transition. Repeat the
   layout pass on a representative touch device.
4. Exercise the request-scoped Connect dialog from the deployed playground and
   confirm the same components perform the extra authorization and return hooks.
5. Recheck live health, Worker bindings, routes, container status, console
   errors, and failed browser requests. Only then call the production reset and
   rollout complete.
6. Commit and push this operational documentation as a focused follow-up, then
   trigger/verify nightly again if the documentation commit becomes the desired
   release head.

## Following slice

Use the Connect playground as the first third-party host and polish every flow
inside an embedded application: new account, current passkey, other passkey,
requested permissions, connector OAuth completion, cancellation, returning
account, and expired-session reauthentication. Keep this as configuration and
hooks around the shared Account library, not a second implementation.
