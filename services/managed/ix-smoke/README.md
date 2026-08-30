# ix compute smoke

This is the live counterpart to `wrangler.computer-provider-smoke.jsonc` for the ix provider.
It deliberately runs under Node 22 rather than inside the Cloudflare Worker bundle: the current
`@indexable/sdk` Node implementation ships a native addon, while Nanocodex's provider boundary
only depends on the structural `ix.machines()` machine API.

```sh
cd services/managed/ix-smoke
npm install
IX_TOKEN=... npm run smoke
```

`IX_REGION` optionally pins the region. The smoke lazily boots one ix machine, writes a tiny Rust
crate into `/workspace`, runs `cargo test` using Rust from Nix, and deletes the machine in `finally`.
Set `IX_SMOKE_KEEP=1` only when debugging a failed machine.
