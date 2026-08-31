# ix compute smoke

This is the live counterpart to `wrangler.computer-provider-smoke.jsonc` for the ix provider.
It deliberately runs the official `@indexable/sdk` under Node 24. The production Managed Worker
uses the same ix machine operations through `../ix-broker`: ix's browser SDK speaks WebTransport,
which Cloudflare Workers do not currently expose, so the broker keeps that transport detail outside
Workerd while remaining stateless.

```sh
cd services/managed/ix-smoke
npm install
IX_TOKEN=... npm run smoke
```

`IX_REGION` optionally pins the region. The smoke boots one real ix machine, writes a tiny Rust
crate into `/workspace`, runs `cargo test` using Rust from Nix, and deletes the machine in `finally`.
Set `IX_SMOKE_KEEP=1` only when debugging a failed machine.

The production path is:

```text
Managed Worker
    -> authenticated HTTPS
ix-broker (Node 24, IX_TOKEN)
    -> @indexable/sdk
ix machine
```

The broker reconnects each operation with `machines().connect(machineId)`, so it holds no durable
machine registry or workspace state.
