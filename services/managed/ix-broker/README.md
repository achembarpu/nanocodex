# Nanocodex ix broker

Small stateless control service that lets the Cloudflare Managed Worker use
ix.dev as a `ManagedComputerProvider`.

The ix browser SDK uses WebTransport. Cloudflare Workers do not currently expose
WebTransport, so the Worker talks ordinary authenticated HTTPS to this Node 24
service. The broker owns only the ix SDK transport; source files and commands are
projected directly into the ix VM through the SDK.

## Run

```bash
npm install
IX_TOKEN=... \
NANOCODEX_IX_BROKER_TOKEN=... \
PORT=8789 \
npm start
```

The broker is stateless. Every operation reconnects with
`client.machines().connect(machineId)`, so multiple replicas may sit behind a
normal load balancer and may restart without losing the machine.

## Managed configuration

Construct the provider with:

```ts
createIxBrokerComputerProvider({
  brokerUrl: "https://ix-broker.example.com",
  brokerToken: env.NANOCODEX_IX_BROKER_TOKEN,
  workspace,
})
```

The first native execution creates an ix machine. Later native executions reuse
that machine through the existing Nanocodex provider lifecycle, and provider
disposal deletes it.

The HTTP surface is deliberately tiny:

- `POST /v1/machines`
- `POST /v1/machines/:id/exec`
- `PUT /v1/machines/:id/files`
- `DELETE /v1/machines/:id`

All requests require the configured bearer token.
