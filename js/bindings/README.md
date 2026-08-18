# Nanocodex for JavaScript

The Node and browser entrypoints expose the same viem-v3-style API over the
same Rust/WASM agent. Runtime-specific host options are flattened into
`Agent.create(...)`; generated WASM handles and host routing remain private.

```js
import { Actions, Agent } from "nanocodex/node";

const agent = await Agent.create({
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-5.6-luna",
  instructions: "You are a Rust coding agent. Preserve unrelated work and run relevant tests.",
  reasoningMode: "pro",
  thinking: "high",
  tools,
  workspace: process.cwd(),
});

const turn = agent.turn.prompt({ input: "Build the thing." });
const result = await turn.result();
turn.dispose();
console.log(result.finalMessage);
console.log(result.usage);
console.log(result.usage.estimated_cost?.usd);
console.log(result.usage.cost_status);

await agent.session.setThinking("high");
await agent.session.setFastMode(true);
await agent.session.compact();

const branch = await agent.session.fork({ at: result });
const branchTurn = branch.turn.prompt({ input: "Try another approach." });
const branchResult = await branchTurn.result();
branchTurn.dispose();
console.log(branchResult.finalMessage);

const followOn = Actions.turn.prompt(agent, { input: "Now explain it." });
console.log((await Actions.turn.getResult(followOn)).finalMessage);
followOn.dispose();
await branch.session.shutdown();
await agent.session.shutdown();
```

## Persistent workspaces

Runtime-specific `Workspace` adapters give an embedding application one file
contract for both local browser kernels and Node kernels. The browser adapter
uses the origin-private file system (OPFS), so reopening the same stable name
after a Worker, page, or agent-session restart reuses its files. The Node
adapter roots the same operations in an ordinary directory and refuses path
traversal and symbolic-link escapes.

```js
import { Agent, Workspace } from "nanocodex/browser";

const workspace = await Workspace.open({ name: "my-notebook" });
const agent = await Agent.create({
  apiKey,
  filesystem: workspace,
});

await workspace.writeFile("README.md", "# Durable browser workspace\n");
console.log(await workspace.list(".", { recursive: true }));
```

The returned handle is application-owned and remains usable by a file browser,
editor, upload/download surface, or another agent session. `Workspace.tools`
exposes bounded `list_files`, `read_file`, `write_file`, `make_directory`, and
`delete_file` operations through the normal caller-defined tool boundary. It
does not add a fake browser shell.

Node uses the same shape with a real directory:

```js
import { Agent, Workspace } from "nanocodex/node";

const workspace = await Workspace.open({ path: process.cwd() });
const agent = await Agent.create({
  apiKey: process.env.OPENAI_API_KEY,
  filesystem: workspace,
});
```

Node and browser applications can instead pay through MPP without an OpenAI
API key. Pass an MPP session with a `ws(endpoint)` method; an `mppx` Tempo
session manager has this shape. Nanocodex defaults the socket to
`wss://openai.mpp.tempo.xyz/v1/responses` when `mpp` is present.

```js
import { Agent, createTempoProviderFromAccounts } from "nanocodex/node";
import { Expiry } from "accounts";
import { Provider } from "accounts/cli";
import { parseUnits } from "viem";
import { connect } from "viem/experimental/erc7846";
import WebSocket from "ws";

const pathUsd = "0x20c0000000000000000000000000000000000000";
const provider = Provider.create({ mpp: false });
if (!provider.store.persist.hasHydrated()) {
  await new Promise((resolve) => provider.store.persist.onFinishHydration(resolve));
}
const status = await provider.getAccessKeyStatus();
if (status === "missing" || status === "expired") {
  await connect(provider.getClient(), {
    capabilities: { authorizeAccessKey: {
      expiry: Expiry.days(1),
      limits: [{ token: pathUsd, limit: parseUnits("25", 6) }],
    } },
  });
}
const root = provider.getAccount();
const account = await provider.store.accessKeys.select({
  account: root.address,
  chainId: provider.getClient().chain.id,
});
if (!account) throw new Error("Tempo account has no usable access key");
console.error(`Tempo access-key signer: ${account.accessKeyAddress}`);
const tempoProvider = await createTempoProviderFromAccounts({
  wallet: provider,
  accessKey: account.accessKeyAddress,
  policy: {
    autoSwap: { tokenIn: [pathUsd], slippage: 1 },
    maxDeposit: "0.05",
    topUpAmount: "0.05",
  },
  session: { bootstrap: true, webSocket: WebSocket },
});
const mpp = tempoProvider.session;

const agent = await Agent.create({ mpp: tempoProvider, thinking: "none", fastMode: true, tools });
const events = agent.events.watch();
const unwatch = events.onEvent((event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
});
let turn;
try {
  turn = agent.turn.prompt({ input: "Build the thing." });
  const result = await turn.result();
  console.error(result.finalMessage);
} finally {
  turn?.dispose();
  unwatch();
  events.off();
  const cleanupErrors = [];
  try {
    await agent.session.shutdown();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await mpp.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "agent shutdown and MPP settlement both failed");
  }
}
```

The application still owns its wallet, deposit policy, persisted payment
channel store, and final settlement. Keep the manager alive to reuse its channel
across agents, and supply mppx `channelStore` for reuse after a process or page
restart. Nanocodex never closes a caller-owned MPP session. `apiKey` and `mpp`
are mutually exclusive. `createTempoProviderFromAccounts({ wallet, ... })`
accepts any provider returned by Accounts SDK `Provider.create(...)`, regardless
of its wallet adapter, and constructs both payment paths from that provider's
adapter-neutral `getMppxParameters()` contract. The lower-level
`createTempoProvider({ session, payment })` remains available when the
application constructs MPPx itself. Both explicitly select Tempo provider mode.
In that mode Nanocodex automatically adds its built-in Mercator MCP and wraps it
with the same wallet and payment policy.
Passing a generic `MppSession`, an OpenAI key, or ChatGPT host auth does not
initialize Mercator. Pass `mcp: false` to opt out explicitly.

Remote Streamable HTTP MCP servers are configured directly on the agent. The
JavaScript binding uses the official MCP SDK transport, keeps remote tools
deferred, and mirrors native Nanocodex exposure: the initial Responses request
contains provider-native `tool_search`, while canonical `mcp__<server>__<tool>`
functions are callable only below Code Mode. Code Mode also exposes
`tools.tool_search`, so one cell can discover a deferred tool and invoke the
returned canonical name. Search results return loadable namespaces for the next
model request; remote tools never become a flat set of top-level model-visible
calls.

MPP-enabled MCP uses MPPx's in-place `McpClient.wrap`. The public `tempo()`
method supports both Tempo charge and session challenges, so paid services
composed behind Mercator use the same signer and spending policy as the model:

```js
const mcpMethod = tempo({
  account,
  channelStore,
  getClient: () => provider.getClient(),
  maxDeposit: "0.05",
  topUpAmount: "0.05",
});

const agent = await Agent.create({
  mpp: createTempoProvider({
    session: mpp,
    payment: { methods: [mcpMethod] },
  }),
});
```

Explicit `mcp` entries are merged over the Tempo defaults, so an application
can replace `mercator` or add other servers without rebuilding the provider.

Each server also accepts `headers`, `fetch`, allow/deny tool lists, a timeout,
or an already initialized MCP SDK-compatible `client`. Nanocodex closes clients
it creates and leaves caller-owned clients open. Connection failures are
reported by `tool_search` so one unavailable server does not prevent the agent
from starting.

Runtimes whose content-security policy rejects `eval`/`new Function` can supply
a Code Mode evaluator. `createQuickJsEvaluator` accepts an asyncified
`quickjs-emscripten-core` module, serializes Asyncify execution, and exposes only
the standard Nanocodex Code Mode globals across the interpreter boundary. This
keeps deferred MCP plus Code Mode functional in Cloudflare Workers:

```js
import asyncVariant from "@jitl/quickjs-wasmfile-release-asyncify";
import { Agent, createQuickJsEvaluator, createTempoProvider } from "nanocodex/browser";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";

const quickJs = await newQuickJSAsyncWASMModuleFromVariant(asyncVariant);
const agent = await Agent.create({
  // module, mpp, and mcp omitted here
  codeEvaluator: createQuickJsEvaluator(quickJs),
});
```

Cloudflare requires the QuickJS `.wasm` file to be statically imported and
passed with `newVariant(..., { wasmModule })`; the complete deployment is in
`examples/cloudflare-fetch-mcp`.

Completed results can be persisted and resumed by a fresh Node or browser
agent:

```js
const snapshot = result.snapshot;
await agent.session.shutdown();

const resumed = await Agent.create({
  apiKey: process.env.OPENAI_API_KEY,
  resume: snapshot,
  tools,
});
await resumed.session.shutdown();
```

The snapshot contains authoritative typed history but no provider response ID,
so the first resumed request safely replays the committed conversation. Resume
with the same instructions and tool definitions, and release the original
agent before handing its snapshot to another writer.

For crash recovery inside a turn, provide the generic durability host instead
of manually persisting snapshots. The host stores opaque Rust journal batches;
model replay, tool ambiguity, operation deduplication, and checkpoint recovery
remain in Rust/WASM:

```js
const agent = await Agent.create({
  apiKey: process.env.OPENAI_API_KEY,
  durability: {
    async load(journalId) {
      return database.loadJournal(journalId);
    },
    async append(journalId, { expectedRevision, payload }) {
      return database.compareAndAppend(journalId, expectedRevision, payload);
      // { status: "appended", revision: "8" }
      // or { status: "conflict", actualRevision: "8" }
    },
  },
  durabilityId: "customer-agent-123",
});

// Every prompt is journaled because durability is configured. Supply `id`
// only when an external retry must identify the same logical operation.
const turn = agent.turn.prompt({ input: "Build the thing." });
// const turn = agent.turn.prompt({ id: "request-7", input: "Build the thing." });
console.log((await turn.result()).finalMessage);
```

Revisions are unsigned decimal strings so JavaScript preserves Rust's full
`u64` range. TypeScript exposes them as a nominal `DurabilityRevision`; use the
exported `durabilityRevision(value)` validator when converting database text or
incremented `bigint`s. Durable step hosts can use
`createMemoryDurabilityStore(journalId, priorSnapshot)` and carry its
`snapshot()` into the next step. SQLite hosts can use
`createSqliteDurabilityStore({ transaction })`; the transaction's query adapter
is the only platform-specific code. See `examples/cloudflare-workers`,
`examples/vercel-workflows`, and `examples/rivet-actors` for all three host
shapes.

Node embedders whose bundler relocates package assets may compile and pass the
web-target artifact explicitly. The runtime still uses the Node host for
WebSockets and Code Mode:

```js
const module = await WebAssembly.compile(await readFile(wasmAssetPath));
const agent = await Agent.create({ apiKey, module });
```

A Codex-compatible rollout can also be resumed by materializing its committed
`response_item` history into a snapshot with no `request_prefix`. Nanocodex
rebuilds the current prefix from the supplied instructions and JavaScript tools
while preserving the rollout's workspace, lineage, cache key, canonical user
context, and typed history.

`Agent` and `Actions` are module namespaces, not classes. `Agent.create` returns
an owned client decorated with matching domain actions:

- `agent.turn.prompt(...)` / `Actions.turn.prompt(agent, ...)`
- `turn.result()` / `Actions.turn.getResult(turn)`
- `result.snapshot` / `Actions.turn.getSnapshot(result)`
- `result.usage` / `Actions.turn.getUsage(result)`
- `agent.session.fork(...)` / `Actions.session.fork(agent, ...)`
- `agent.session.compact()` / `Actions.session.compact(agent)`
- `agent.session.setThinking(...)` / `Actions.session.setThinking(agent, ...)`
- `agent.session.setFastMode(...)` / `Actions.session.setFastMode(agent, ...)`
- `agent.session.shutdown()` / `Actions.session.shutdown(agent)`
- `agent.session.spawn()` / `Actions.session.spawn(agent)`
- `agent.events.watch(...)` / `Actions.events.watch(agent, ...)`

`turn.result()` resolves to a frozen completed `TurnResult`. Its
`finalMessage` is eager; `usage` and `snapshot` cross the WASM boundary lazily
once and are then cached. Historical `fork({ at })` accepts this completed
result, never an unfinished turn or a provider response ID.

`turn.dispose()` only releases the JavaScript/WASM handle; like dropping the
Rust `Turn`, it does not cancel accepted work. Await `turn.cancel()` before
disposing unfinished work. At an application or session boundary,
`agent.session.shutdown()` cancels unfinished turns and joins driver, model,
tool, and transport cleanup.

Every action owns its types, for example `Actions.turn.prompt.Options`,
`Actions.turn.prompt.ReturnType`, and `Actions.events.watch.Watcher`.

Event watches are lazy, terminal handles:

```js
const watch = agent.events.watch();
const unlisten = watch.onEvent(console.log);

unlisten();
watch.off();
```

A throwing callback is reported through the host's `reportError` hook (or
`console.error` when that hook is unavailable) without interrupting later
listeners or the owned agent lifecycle.

The same watcher can instead be consumed as an ordered async iterable; breaking
the loop releases that iterator, while `watch.off()` terminates the whole watch.

```js
const watch = agent.events.watch();
for await (const event of watch) {
  console.log(event);
  if (done) break;
}
watch.off();
```

Applications add typed action domains with decorators:

```js
const extended = agent.extend((client) => ({
  inspect: {
    session: () => client.sessionId,
  },
}));

extended.inspect.session();
```

Browser Workers use the identical shape:

```js
import { Agent } from "nanocodex/browser";

const agent = await Agent.create({
  websocketUrl: signedOrCookieAuthorizedEndpoint,
  createWebSocket(endpoint, sessionId) {
    const url = new URL(endpoint);
    url.searchParams.set("session_id", sessionId);
    return new WebSocket(url);
  },
  tools,
});
```

Server-side Worker runtimes can await a `fetch()`-based WebSocket upgrade. The
third callback argument is a discriminated authorization request plus connection
metadata. With `apiKey`, `authorization` is `"bearer"` and `bearerToken` is
present. With `hostAuth: true`, it is `"host_managed"`; the host must resolve
credentials without exposing them to WASM. Do not retain or log bearer tokens.
Return the socket alone or a descriptor containing response metadata:

```js
import { Agent } from "nanocodex/browser";
import module from "nanocodex/wasm";

const agent = await Agent.create({
  apiKey,
  module,
  async createWebSocket(endpoint, sessionId, request) {
    if (request.authorization !== "bearer") {
      throw new Error("this host requires Nanocodex bearer authorization");
    }
    const response = await fetch(endpoint.replace("wss:", "https:"), {
      headers: {
        Authorization: `Bearer ${request.bearerToken}`,
        Upgrade: "websocket",
        "session-id": sessionId,
      },
    });
    if (!response.webSocket) throw new Error(`upgrade failed: ${response.status}`);
    response.webSocket.accept();
    return { socket: response.webSocket, status: response.status };
  },
});
```

`hostAuth` is useful when the embedding runtime owns rotating credentials. The
callback can acquire a fresh token, attempt the upgrade, and refresh-and-retry
on 401. Bound and reject upgrade work in the callback: until it returns a
socket, there is no connection handle for Nanocodex to close. `apiKey`,
`hostAuth`, and `mpp` are mutually exclusive.

After publication, a browser can load the same entrypoint without a package
manager or build step:

```html
<script type="module">
  import { Agent } from "https://cdn.jsdelivr.net/npm/nanocodex@0.5.0/browser/index.mjs";
  const agent = await Agent.create({ websocketUrl: "/api/responses" });
  const turn = agent.turn.prompt({ input: "Hello." });
  try {
    const result = await turn.result();
    console.log(result.finalMessage);
  } finally {
    turn.dispose();
    await agent.session.shutdown();
  }
</script>
```

Pin the package version in production. The adjacent WASM file is part of the
npm package and is resolved relative to the browser module. The endpoint must
be authorized by the embedding application because browser WebSockets cannot
attach OpenAI's upgrade authorization header.

The owned Rust session retains follow-on history, response state, tool output,
its WebSocket, and stable prompt-cache identity. Typed browser content accepts
ordered text, remote/data-URL image, and audio items. JavaScript tools are
ordinary async handlers described by JSON Schema and appear in the same ordered
agent event stream as built-in code mode.

Run the standalone Node proof with:

```sh
cd examples/node
npm install
OPENAI_API_KEY=... npm start
```
