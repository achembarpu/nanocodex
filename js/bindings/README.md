# Nanocodex for JavaScript

The Node and browser entrypoints expose the same viem-v3-style API over the
same Rust/WASM agent. A required Responses `Transport` owns authentication and
socket setup; `Agent.create(...)` owns agent policy, tools, and lifecycle.
Generated WASM handles and host routing remain private.

```js
import { Actions, Agent, Transport } from "nanocodex/node";

const agent = await Agent.create({
  transport: Transport.openAi({ apiKey: process.env.OPENAI_API_KEY }),
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

Transports are explicit, immutable configurations, like viem v3 transports:

```js
Transport.openAi({ apiKey, websocketUrl });
Transport.chatGpt({ subscription });
Transport.mpp({ session: paymentSession });
```

The browser entrypoint additionally exposes `Transport.hostManaged(...)` for a
Worker, Durable Object, or application proxy that owns rotating credentials.
Authentication modes are constructors rather than a union of mutually
exclusive fields on `Agent.create`.

Task-tree orchestration is an optional extension over the core agent. Both
native and WASM consumers run the same Rust implementation and receive the
same seven tools: `spawn_agent`, `submit_result`, `send_agent_message`,
`list_agents`, `wait_agent`, `interrupt_agent`, and `close_agent`.

```js
import { Agent, Subagents, Transport } from "nanocodex/browser";
import nanocodexWasm from "./nanocodex.wasm";

const myApplicationTool = {
  name: "lookup_order",
  description: "Look up one order.",
  parameters: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: ({ id }) => orders.get(id),
};

const agent = await Agent.create({
  module: nanocodexWasm,
  transport: Transport.hostManaged({
    websocketUrl: "/api/responses",
    createWebSocket: (endpoint) => new WebSocket(endpoint),
  }),
  tools: [
    myApplicationTool,
    ...Subagents.create({ maxConcurrency: 8 }),
  ],
});
```

`parameters` is optional and defaults to an open object. TypeScript types are
erased at runtime, so provide JSON Schema only when the model needs a precise
argument contract, as `lookup_order` does above.

## Standard web and browser tools

`nanocodex/tools` contains composable named tools rather than another agent or
runtime. Each factory returns an entry that can sit beside application tools
and Rust/WASM extensions in the same array:

```js
import { Agent, Subagents, Transport } from "nanocodex/browser";
import {
  dataset,
  imageGeneration,
  updatePlan,
  web,
} from "nanocodex/tools";

const agent = await Agent.create({
  transport: Transport.hostManaged({
    websocketUrl: "/api/responses",
    createWebSocket: (endpoint) => new WebSocket(endpoint),
  }),
  tools: [
    web(),
    dataset(),
    imageGeneration({
      recentImages: (sessionId, count) => images.get(sessionId).slice(-count),
      rememberImage: (sessionId, imageUrl) => images.get(sessionId).push(imageUrl),
    }),
    updatePlan(),
    myApplicationTool,
    ...Subagents.create({ maxConcurrency: 8 }),
  ],
});
```

The web and image factories use the canonical OpenAI/Codex tool names, argument
schemas, bounds, and image-edit modes, and normalize common malformed model
arguments before dispatch. In a browser, they default to the same-origin
`/api/tools/web-search` and `/api/tools/image-generation` routes. The host owns
only a bounded JSON endpoint, credentials, authorization, and persistence.
`web(...)` posts `{ commands, session_id }`; `imageGeneration(...)` posts
`{ images, prompt }`. Pass `url` when the host route lives elsewhere.

`dataset()` runs entirely in the caller and inspects public HTTPS Parquet,
uncompressed JSONL, and Hugging Face datasets. It opens a session-scoped handle,
returns schema metadata, and supports projection and filtering queries without
hard row or offset ceilings. Input and output bytes remain bounded; partial
results return an opaque `nextCursor` that retains the query and resumes from a
physical Parquet row batch or JSONL byte position. Parquet uses HTTP range reads
and predicate pushdown where possible; JSONL scans incrementally and requires
byte-range support for cursor continuation. The implementation, Parquet reader,
and non-Snappy codecs load only after the model first calls the tool. Direct URLs
must allow browser CORS, and Parquet servers must support byte ranges.
Consumers that only need this capability can import `dataset` from the smaller
`nanocodex/tools/dataset` leaf entry.

```js
const datasets = dataset();
const opened = await datasets.handler({
  operation: "open",
  source: {
    kind: "huggingface",
    dataset: "openai/gsm8k",
    config: "main",
    split: "train",
  },
}, { sessionId: "thread-1" });

const page = await datasets.handler({
  operation: "query",
  dataset_id: opened.datasetId,
  columns: ["question", "answer"],
  filters: [{ column: "question", op: "contains", value: "how many" }],
  limit: 5,
}, { sessionId: "thread-1" });

if (page.nextCursor) {
  await datasets.handler({
    operation: "query",
    dataset_id: opened.datasetId,
    cursor: page.nextCursor,
    limit: 5,
  }, { sessionId: "thread-1" });
}
```

This same adapter works inside a Cloudflare Worker or Durable Object:

```js
import { Agent, Subagents, Transport } from "nanocodex/browser";
import { web } from "nanocodex/tools";

const agent = await Agent.create({
  module: env.NANOCODEX_WASM,
  transport: Transport.hostManaged({
    websocketUrl: env.RESPONSES_WEBSOCKET_URL,
    createWebSocket: (endpoint) => new WebSocket(endpoint),
  }),
  toolMode: "direct",
  tools: [
    web({
      url: env.WEB_TOOL_URL,
      headers: { authorization: `Bearer ${env.WEB_TOOL_TOKEN}` },
    }),
    ...Subagents.create(),
  ],
});
```

For a browser Agent Worker, `browser(...)` composes the same tools with one
persistent OPFS workspace and a lazy WASM-backed shell (Python through Pyodide,
C/C++ through wasm-clang, plus browser Git and bounded commands):

```js
import { browser } from "nanocodex/tools/browser";

const runtime = await browser({
  threadId,
  recentImages,
  rememberImage,
});

const agent = await Agent.create({
  transport,
  filesystem: runtime.filesystem,
  instructions: runtime.instructions,
  executionEnvironment: {
    currentDate,
    timezone,
    projectInstructions: runtime.projectInstructions,
  },
  tools: [...runtime.tools, ...Subagents.create()],
});
```

`browser(...)` runs in a browser Worker because OPFS is a browser capability;
use the individual factories in server-side Cloudflare Workers. Vite consumers
install the package-owned SSH compatibility adapter in both page and nested
Worker plugin graphs:

```js
import { nanocodexTools } from "nanocodex/tools/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [nanocodexTools()],
  worker: { format: "es", plugins: () => [nanocodexTools()] },
});
```

The browser composition includes `render_artifact` as a normal typed tool. For
other hosts, compose the same factory with any workspace implementing the
Nanocodex workspace contract:

```js
import { artifact, web } from "nanocodex/tools";

const tools = [
  web({ url: env.WEB_TOOL_URL }),
  artifact({ workspace }),
];
```

The artifact factory performs no dynamic evaluation and is safe to load in a
Cloudflare Worker. Browser hosts additionally install the exact iframe syntax
validator. The model calls `tools.render_artifact({ id, title, source })` from
Code Mode, or `render_artifact` directly when the host selects direct mode; no
artifact CLI is installed. Artifact capacity is host-owned: the binding adds no
byte, source-length, ID-length, or document-count policy limits.

Application tools may provide `outputSchema` alongside `parameters`. The
binding serializes it to Rust's `output_schema`, so Code Mode receives the same
generated TypeScript return declaration as native Codex tools instead of
guessing result fields:

```js
const execCommand = {
  name: "exec_command",
  description: "Run a command.",
  parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  outputSchema: {
    type: "object",
    properties: { output: { type: "string" }, wall_time_seconds: { type: "number" } },
    required: ["output", "wall_time_seconds"],
    additionalProperties: false,
  },
  handler: runCommand,
};
```

This is what loading a Rust-written tool from JavaScript looks like here.
`nanocodex-subagents` is statically linked into `nanocodex.wasm`; importing the
module loads that Rust code, and spreading `Subagents.create()` into `tools`
selects it for this agent. The spread contributes one opaque extension entry,
not seven JavaScript handlers. Inside the binding, Rust creates one shared
registry and installs fresh tools for every root, spawn, and fork:

```rust,ignore
let (registry, control, updates) = nanocodex_subagents::channel(max_concurrency);
let tools = HostedTools::new(javascript_host);
let (agent, events) = Nanocodex::builder(openai)
    .tools_factory(move |handle| {
        nanocodex_subagents::install_tools(tools.clone(), handle, registry.clone())
    })
    .build()?;
```

This is deliberately static composition, not a generic runtime loader for an
arbitrary second `.wasm` plugin. A custom Rust extension is linked into the
binding crate at build time and exposed by a small branded JS configuration;
adding a dynamic component ABI would be a separate feature with a much larger
contract and runtime cost.

The root owns the task tree. `agent.session.shutdown()` closes every child
before stopping the root driver; applications do not maintain a parallel JS
scheduler or reimplement the communication tools.

## Persistent workspaces

Runtime-specific `Workspace` adapters give an embedding application one file
contract for both local browser kernels and Node kernels. The browser adapter
uses the origin-private file system (OPFS), so reopening the same stable name
after a Worker, page, or agent-session restart reuses its files. The Node
adapter roots the same operations in an ordinary directory and refuses path
traversal and symbolic-link escapes.

```js
import { Agent, Transport, Workspace } from "nanocodex/browser";

const workspace = await Workspace.open({ name: "my-notebook" });
const agent = await Agent.create({
  transport: Transport.hostManaged({
    websocketUrl: "/api/responses",
    createWebSocket: (endpoint) => new WebSocket(endpoint),
  }),
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
import { Agent, Transport, Workspace } from "nanocodex/node";

const workspace = await Workspace.open({ path: process.cwd() });
const agent = await Agent.create({
  transport: Transport.openAi({ apiKey: process.env.OPENAI_API_KEY }),
  filesystem: workspace,
});
```

Node and browser applications can instead pay through MPP without an OpenAI
API key. Pass an MPP session with a `ws(endpoint)` method; an `mppx` Tempo
session manager has this shape. Nanocodex defaults the socket to
`wss://openai.mpp.tempo.xyz/v1/responses` when `mpp` is present.

```js
import { Agent, createTempoProviderFromAccounts, Transport } from "nanocodex/node";
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

const agent = await Agent.create({
  transport: Transport.mpp({ session: tempoProvider }),
  thinking: "none",
  fastMode: true,
  tools,
});
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
restart. Nanocodex never closes a caller-owned MPP session.
`createTempoProviderFromAccounts({ wallet, ... })`
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
  transport: Transport.mpp({
    session: createTempoProvider({
      session: mpp,
      payment: { methods: [mcpMethod] },
    }),
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
import { Agent, createQuickJsEvaluator, createTempoProvider, Transport } from "nanocodex/browser";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";

const quickJs = await newQuickJSAsyncWASMModuleFromVariant(asyncVariant);
const agent = await Agent.create({
  transport: Transport.mpp({ session: tempoProvider }),
  // module and mcp omitted here
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
  transport: Transport.openAi({ apiKey: process.env.OPENAI_API_KEY }),
  resume: snapshot,
  tools,
});
await resumed.session.shutdown();
```

The snapshot contains authoritative typed history but no provider response ID,
so the first resumed request safely replays the committed conversation. Resume
with the same instructions and tool definitions, and release the original
agent before handing its snapshot to another writer.

Node embedders whose bundler relocates package assets may compile and pass the
web-target artifact explicitly. The runtime still uses the Node host for
WebSockets and Code Mode:

```js
const module = await WebAssembly.compile(await readFile(wasmAssetPath));
const agent = await Agent.create({ transport: Transport.openAi({ apiKey }), module });
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
import { Agent, Transport } from "nanocodex/browser";

const agent = await Agent.create({
  transport: Transport.hostManaged({
    websocketUrl: signedOrCookieAuthorizedEndpoint,
    createWebSocket(endpoint, sessionId) {
      const url = new URL(endpoint);
      url.searchParams.set("session_id", sessionId);
      return new WebSocket(url);
    },
  }),
  tools,
});
```

Server-side Worker runtimes can await a `fetch()`-based WebSocket upgrade. The
third callback argument is a discriminated authorization request plus connection
metadata. With `Transport.openAi`, `authorization` is `"bearer"` and
`bearerToken` is present. With `Transport.hostManaged`, it is `"host_managed"`;
the host must resolve
credentials without exposing them to WASM. Do not retain or log bearer tokens.
Return the socket alone or a descriptor containing response metadata:

```js
import { Agent, Transport } from "nanocodex/browser";
import module from "nanocodex/wasm";

const agent = await Agent.create({
  transport: Transport.openAi({
    apiKey,
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
  }),
  module,
});
```

`Transport.hostManaged` is useful when the embedding runtime owns rotating credentials. The
callback can acquire a fresh token, attempt the upgrade, and refresh-and-retry
on 401. Bound and reject upgrade work in the callback: until it returns a
socket, there is no connection handle for Nanocodex to close. Selecting one
transport makes authentication modes mutually exclusive by construction.

After publication, a browser can load the same entrypoint without a package
manager or build step:

```html
<script type="module">
  import { Agent, Transport } from "https://cdn.jsdelivr.net/npm/nanocodex@0.5.0/browser/index.mjs";
  const agent = await Agent.create({
    transport: Transport.hostManaged({
      websocketUrl: "/api/responses",
      createWebSocket: (endpoint) => new WebSocket(endpoint),
    }),
  });
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
