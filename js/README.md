# JavaScript libraries

- [`bindings`](bindings) publishes `nanocodex`: runtime-specific `Agent`
  namespaces, domain-grouped `Actions`, decorators, and Node/browser WASM hosts.
- [`react`](react) provides `nanocodex-react`: the external store, provider,
  and hooks for a browser Worker owned by the embedding application.
- [`terminal`](terminal) provides `nanocodex-terminal`: controlled React
  transcript and composer components with an optional canonical stylesheet.
- [`artifacts`](artifacts) provides `nanocodex-artifacts`: persistent live
  React source documents, bounded workspace storage, and agent tooling.

Only the headless core `nanocodex` binding is currently registry-published.
`nanocodex-react` owns semantic conversation state through its headless Agent
controller. `nanocodex-terminal` renders that state without creating Agents,
choosing transports, or owning credentials and persistence. Generated
`wasm-bindgen` output stays private to `nanocodex` and is produced by
`just build-wasm`.
