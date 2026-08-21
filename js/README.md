# JavaScript libraries

- [`bindings`](bindings) publishes `nanocodex`: runtime-specific `Agent`
  namespaces, domain-grouped `Actions`, decorators, and Node/browser WASM hosts.
- [`react`](react) provides `nanocodex-react`: the external store, provider,
  and hooks for a browser Worker owned by the embedding application.
- [`artifacts`](artifacts) provides `nanocodex-artifacts`: persistent live
  React source documents, bounded workspace storage, and agent tooling.

Only the headless core `nanocodex` binding is currently registry-published.
`nanocodex-react` remains an intentionally narrow Context/hooks package over
that SDK, and the artifacts package supplies one concrete application tool.
UI frameworks and terminal renderers consume Agent events directly and remain
application code; there is no SDK-owned transcript, TUI, or terminal adapter
package. Generated `wasm-bindgen` output stays private to `nanocodex` and is
produced by `just build-wasm`.
