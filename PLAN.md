# JavaScript and platform simplification

## Purpose

Make ownership visible in the filesystem and use ordinary Vite and Wrangler
interfaces. This phase is a move-only boundary change: preserve product behavior,
Cloudflare identities, bindings, migrations, stable package exports, and the
Rust/WASM contract. The Vite surface moves intact from `nanocodex/vite` to its
own `nanocodex-vite` package.

## Target tree

```text
js/
├── nanocodex/            stable headless JavaScript contract
├── nanocodex-react/      stable React contract
├── nanocodex-vite/       Vite plugin, WASM build, OAuth relay, Cloudflare glue
├── nanocodex-terminal/   optional React presentation
├── account/              public account application and Worker
├── connect-dialog/       embedded Connect application
├── connect-playground/   Connect example application
├── managed/              hosted-agent Worker
├── egress/               credential and connector Workers
├── connect-api/          Connect API Worker
├── mcp-target.mjs        shared remote-target security boundary
└── mcp-target.d.mts      shared remote-target types
```

Each app and Worker owns its source, configuration, tests, and deployable assets.
No app or Worker imports another deployable's source. Shared code must have one
explicit owner and a public entrypoint; adapters are not a miscellaneous layer.
Rust is unchanged during this JS/platform phase, and generated WASM is its
boundary.

## Stability and evidence

| Tier | Surface | Required evidence |
| --- | --- | --- |
| Stable | `js/nanocodex`, `js/nanocodex-react` | Contract, type, package, and focused runtime tests |
| Build integration | `js/nanocodex-vite` | Plugin/WASM/OAuth contract tests and one real Vite consumer |
| Presentation | `js/nanocodex-terminal` | Build and controlled-component contract tests |
| Product | `js/account`, `js/connect-*`, `js/managed`, `js/egress` | A few policy/boundary tests; primarily canonical browser journeys and real Worker/service boundaries |

Unit tests do not substitute for customer behavior. Record the exact SHA,
browser/device, account/grant context, network and console state, and durable
trace for changed journeys.

## Direct operation

Install only the changed package. From `js/account`, start the complete local
product through the standard Cloudflare Vite plugin with
`npx vite --host 127.0.0.1`; deploy a Worker or asset app from its directory with
`npx wrangler deploy --config wrangler.jsonc`. Workers with multiple checked-in
configs use the same command with the exact config file. Apply D1 migrations
directly with Wrangler only when a migration changed. Deploy existing binding
dependencies first and the public account app last; verify behavior separately
on the canonical URL.

## Behavior matrix

| Journey | Completion evidence |
| --- | --- |
| Root | Every shipped route hydrates and navigates on desktop and touch with no console, request, or asset failure |
| Account | Remembered passkey survives sign-out/reload and reauthenticates without a replacement account |
| Managed | Two turns commit once, survive reload/reconnect, and retain context |
| MCP | Connect, grant, call, revoke, then prove another call is fenced |
| Connect | Approve one exact `wallet_connect` request and expose only its signed projection after reload |
| Attachment | Attach, become ready, execute, detach, and reject stale or ungranted hosts |
| Isolation | Two independent accounts cannot read or execute across agents, history, events, or tools |
| Security | Inspect storage, CSP/framing, sockets/events, failed requests, and provider-secret absence |

## Completion matrix

| Boundary | Complete when |
| --- | --- |
| Layout | Target tree exists; old `web/`, `services/`, and `js/artifacts/` paths are absent |
| Imports | No cross-app/Worker source imports or stale old-tree references remain |
| Packages | Stable bindings/React exports remain compatible; `nanocodex-vite` owns plugin, WASM, and OAuth integration |
| Direct dev | `npx vite --host 127.0.0.1` from `js/account` starts the complete local product through the standard Cloudflare plugin |
| Deployables | Checked-in Vite/Wrangler configs deploy with direct standard commands and no custom stack/deploy/test wrappers |
| Stable tests | Binding, React, Vite, and terminal contract gates pass |
| Browser flows | Every applicable behavior-matrix journey passes on the canonical URL, including desktop/touch and durable or multi-account contexts |
| Scope | Diff is move-only apart from path/config/docs corrections; no Rust file changed |
