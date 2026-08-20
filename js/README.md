# JavaScript libraries

- [`bindings`](bindings) publishes `nanocodex`: runtime-specific `Agent`
  namespaces, domain-grouped `Actions`, decorators, and Node/browser WASM hosts.
- [`react`](react) publishes `nanocodex-react`: the external store, provider,
  and hooks for a browser Worker owned by the embedding application.
- [`artifacts`](artifacts) publishes `nanocodex-artifacts`: persistent live
  React source documents, bounded workspace storage, and agent tooling.
- [`tui`](tui) publishes `nanocodex-tui`: framework-independent transcript
  state and event reduction.
- [`tui-react`](tui-react) publishes `nanocodex-tui-react`: the accessible,
  virtualized, unstyled-by-default terminal renderer and optional theme.
- [`terminal`](terminal) publishes `nanocodex-terminal`: a five-method host
  contract that attaches one retained agent to xterm.js, WTerm, a native TTY,
  a WebSocket, or a headless test without changing agent semantics.

Applications consume package entrypoints. Generated `wasm-bindgen` output
stays private to `nanocodex` and is produced by `just build-wasm`.
