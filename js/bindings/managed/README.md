# Managed Nanocodex agents

`nanocodex/managed` is the control-plane client for account-owned Nanocodex
agents. It is separate from local transports and from the Cloudflare Durable
Object adapter.

In a browser, authentication uses the current origin's HttpOnly account cookie:

```js
import { Agent } from "nanocodex/managed";

const agent = await Agent.create();
const turn = agent.turn.prompt({
  input: "Inspect the repository and summarize it.",
  idempotencyKey: crypto.randomUUID(),
});
const result = await turn.result();
console.log(result.finalMessage);
```

On a server, provide the managed origin and an `ncx_live_...` account API key:

```js
const agent = await Agent.get(process.env.NANOCODEX_AGENT_ID, {
  baseUrl: "https://nanocodex.example",
  apiKey: process.env.NANOCODEX_API_KEY,
});
```

`Agent.list()` returns agent handles, `agent.state()` reads current state, and
`agent.delete()` removes the agent and its retained state. `agent.events.watch`
is an async iterator over durable events. Pass its last decimal `cursor` to a
later watcher to resume strictly after the acknowledged event. Network endings
reconnect automatically from that cursor.

The managed API never accepts model-provider credentials, egress bindings,
runtime environment objects, credential grants, or arbitrary request headers.
