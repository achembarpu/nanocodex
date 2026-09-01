# JavaScript libraries

- [`nanocodex`](nanocodex) publishes `nanocodex`: runtime-specific `Agent`
  namespaces, domain-grouped `Actions`, decorators, and Node/browser WASM hosts.
- [`nanocodex-react`](nanocodex-react) provides `nanocodex-react`: the external store, provider,
  and hooks for a browser Worker owned by the embedding application.
- [`nanocodex-vite`](nanocodex-vite) owns the Nanocodex Vite plugin, WASM build, local OAuth relay,
  and Cloudflare Vite integration.
- [`nanocodex-terminal`](nanocodex-terminal) provides `nanocodex-terminal`: controlled React
  transcript and composer components with an optional canonical stylesheet.
- [`account`](account), [`connect-dialog`](connect-dialog), and
  [`connect-playground`](connect-playground) are product applications.
- [`managed`](managed), [`egress`](egress), and [`connect-api`](connect-api) are
  independently deployable Cloudflare Workers. `mcp-target.mjs` owns their small
  shared remote-target security boundary.

The registry packages are the headless `nanocodex` binding and
`nanocodex-vite`; releases and commit previews publish them together.
`nanocodex-react` owns semantic conversation state through its headless Agent
controller. `nanocodex-terminal` renders that state without creating Agents,
choosing transports, or owning credentials and persistence. Generated
`wasm-bindgen` output stays private to `nanocodex` and is produced by the Vite
package.
