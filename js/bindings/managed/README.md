# Managed Nanocodex agents

`nanocodex/managed` is the administration and extended control-plane client for
account-owned Nanocodex agents. Application turns normally use
`Agent.create({ transport: Transport.managed(...), tools })` from
`nanocodex/node`, `nanocodex/browser`, or `nanocodex/host`, which returns the
same lifecycle shape as local OpenAI and host-managed transports.

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

The transport-facing constructor requires an explicit identity and never
infers creation from a missing ID:

```js
import { Agent, Transport } from "nanocodex/node";

const created = await Agent.create({
  transport: Transport.managed({
    agent: { create: true },
    baseUrl: "https://nanocodex.example",
    apiKey: process.env.NANOCODEX_API_KEY,
  }),
});
const existing = await Agent.create({
  transport: Transport.managed({
    agent: { id: process.env.NANOCODEX_AGENT_ID },
    baseUrl: "https://nanocodex.example",
    apiKey: process.env.NANOCODEX_API_KEY,
  }),
});
await existing.session.shutdown(); // closes the client; never deletes the Agent
```

The same account client can search all completed managed conversations without
opening an agent turn:

```js
const found = await Agent.findSessions(
  { query: "what did we decide about memory?", limit: 8 },
  { baseUrl: process.env.NANOCODEX_MANAGED_URL, apiKey: process.env.NANOCODEX_API_KEY },
);
const session = await Agent.readSession(
  {
    session_id: found.results[0].session_id,
    turn_ids: [found.results[0].turn_id],
  },
  { baseUrl: process.env.NANOCODEX_MANAGED_URL, apiKey: process.env.NANOCODEX_API_KEY },
);
```

Both methods derive the account scope from the cookie or API key; no scope or user
identifier is accepted from the caller.

Hosted durable memory is account-owned and independent from session history. The
memory panel can list records and compare-and-swap delete one current key:

```js
const memories = await Agent.listMemories({
  baseUrl: process.env.NANOCODEX_MANAGED_URL,
  apiKey: process.env.NANOCODEX_API_KEY,
});
await Agent.deleteMemory(memories[0].key, {
  baseUrl: process.env.NANOCODEX_MANAGED_URL,
  apiKey: process.env.NANOCODEX_API_KEY,
});
```

Managed agents access this same hosted store through their `memory` tool. It is
never mirrored into a browser, TUI, or other local persistence layer.

`Agent.list()` returns agent handles, `agent.state()` reads current state, and
`agent.delete()` removes the agent and its retained state. `agent.events.watch`
is an async iterator over durable events. Pass its last decimal `cursor` to a
later watcher to resume strictly after the acknowledged event. Network endings
reconnect automatically from that cursor. Watchers and independently awaitable
turn results on one agent handle share one replayable event connection; each
subscriber keeps its own cursor, so consuming one never steals another's events.
Pass `cursor: "latest"` to attach atomically at the durable head without
replaying retained history; a history page can then hydrate independently.

Returning browser clients may use `Agent.open(id)` to construct a retained
handle without a preliminary state request. The first operation on that handle
still verifies account ownership at the managed service boundary. Use
`Agent.get(id)` when an eager existence check is part of the caller's workflow.

The managed API never accepts model-provider credentials, egress bindings,
runtime environment objects, credential grants, or arbitrary request headers.
