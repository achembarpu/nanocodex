# Local web development

- Run the complete isolated stack with `npm run dev --prefix web`.
- The primary checkout uses `http://nanocodex.localhost:<port>`; worktrees use
  one stable `<instance>.nanocodex.localhost` label and isolated Wrangler state.
- Every instance uses WebAuthn RP ID `nanocodex.localhost`. Exact origin,
  challenge, credential, public-key, and signature checks remain mandatory.
- OrbStack, Docker, local TLS, `.local` DNS, worktree callback URLs, and wildcard
  callbacks are not part of the normal path.
- The shared stateless OAuth relay binds only `127.0.0.1:47891`. Register these
  provider callbacks:
  - `http://127.0.0.1:47891/v1/connectors/github/callback`
  - `http://127.0.0.1:47891/v1/connectors/gmail/callback`
  - `http://127.0.0.1:47891/v1/connectors/gdrive/callback`
  - `http://127.0.0.1:47891/v1/connectors/x/callback`
  - `http://127.0.0.1:47891/v1/mcp-connections/<connection-id>/callback`
- Provider token exchange and PKCE stay in the private broker. Provider secrets
  and tokens never enter browser storage or CLI output.
- Verify passkey reuse across two checkout instances, Account and Connect OAuth,
  CLI login/connect, reload, desktop/touch layout, and secret absence.
