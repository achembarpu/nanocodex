# Nanocodex development

Read `PLAN.md` for the active boundary and completion matrix.

- `js/nanocodex` and `js/nanocodex-react` are stable contracts. Cover changes
  with focused contract, type, package, and runtime tests.
- `js/nanocodex-vite` owns the Vite plugin, WASM build, OAuth relay, and Cloudflare Vite
  integration. Do not recreate those responsibilities in apps or adapters.
- Adapters are not a dumping ground. Put behavior at its real owner and expose a
  narrow entrypoint.
- Apps and Workers are independent deployables. Never import another app's or
  Worker's source; shared code needs an explicit package owner.
- During JS/platform work, do not edit Rust unless the user explicitly requests
  it. Generated WASM is the Rust boundary.
- Product code gets almost no unit tests: keep only pure policy and important
  protocol boundaries. Require canonical browser and real service/Worker
  evidence for product behavior.
- Develop directly from `js/account` with the standard Vite command and
  Cloudflare plugin: `npx vite --host 127.0.0.1`. Deploy each checked-in config
  directly with `npx wrangler deploy --config <config>`.
- Do not add custom stack, deploy, test, rollout, probe, or verification wrappers.
  Keep installs, migrations, resource changes, deployment, and evidence explicit.
- Wrangler upload success is not behavior evidence. Exercise the exact changed
  journey, inspect console/network/storage/sockets/CSP, and verify provider
  secrets never reach browser or app surfaces.
- Preserve Cloudflare names, bindings, migrations, grants, durable state, public
  exports, and customer behavior during moves.
- Never mix, delete, or reset concurrent work; never commit secrets, generated
  builds, caches, retained jobs, or another user's files.
