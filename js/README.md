# JavaScript libraries

- [`bindings`](bindings) publishes `nanocodex`: runtime-specific `Agent`
  namespaces, domain-grouped `Actions`, decorators, and Node/browser WASM hosts.
- [`react`](react) publishes `nanocodex-react`: the external store, provider,
  and hooks for a browser Worker owned by the embedding application.
- [`artifacts`](artifacts) publishes `nanocodex-artifacts`: strict declarative
  artifact documents, bounded workspace persistence, and agent tooling.
- [`artifacts-react`](artifacts-react) publishes `nanocodex-artifacts-react`:
  an accessible, dependency-light renderer with replaceable components and
  caller-injected file and action capabilities.
- [`tui`](tui) publishes `nanocodex-tui`: framework-independent transcript
  state and event reduction.
- [`tui-react`](tui-react) publishes `nanocodex-tui-react`: the accessible,
  virtualized, unstyled-by-default terminal renderer and optional theme.

Applications consume package entrypoints. Generated `wasm-bindgen` output
stays private to `nanocodex` and is produced by `just build-wasm`.
