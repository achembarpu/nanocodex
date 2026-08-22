import {
  Actions,
  Agent,
  type AgentSessionContext,
  ChatGptSubscription,
  type AccountsWallet,
  type CostStatus,
  type McpServer,
  createTempoProviderFromAccounts,
  createMemoryChatGptSubscriptionStore,
  Subagents,
  type SessionSnapshot,
  type Tool,
  Transport,
  type Turn,
  type TurnResult,
  Workspace,
} from "../node/index.mjs";
import {
  Agent as BrowserAgent,
  Subagents as BrowserSubagents,
  Transport as BrowserTransport,
  Workspace as BrowserWorkspace,
} from "../browser/index.mjs";
import {
  Agent as HostAgent,
  type BrowserWebSocketRequest,
  Transport as HostTransport,
} from "../host/index.mjs";
import type * as RootPublicTypes from "../index.mjs";
import type * as BrowserPublicTypes from "../browser/index.mjs";
import type * as HostPublicTypes from "../host/index.mjs";
import type * as NodePublicTypes from "../node/index.mjs";
import type { WorkspaceEntry as BrowserWorkspaceEntry } from "../browser/workspace.mjs";
import type { WorkspaceEntry as NodeWorkspaceEntry } from "../node/workspace.mjs";
import {
  createWorkerAgent,
  prepareWorkerAgent,
} from "../browser/WorkerAgent.mjs";
import {
  dataset,
  imageGeneration,
  updatePlan,
  viewImage,
  web,
} from "../tools/index.mjs";
import {
  dataset as leafDataset,
  type DatasetOptions,
} from "../tools/dataset.mjs";
import { browser as browserTools } from "../tools/browser/index.mjs";
import { nanocodexTools } from "../tools/vite.mjs";
import {
  createMemoryDurabilityStore,
  durabilityRevision,
  type DurabilityAppendRequest,
  type DurabilityAppendResult,
  type DurabilityRevision,
  type DurabilitySqliteQuery,
  type DurabilitySqliteRow,
  type DurabilitySqliteTransaction,
  type DurabilitySqliteValue,
  type DurabilityStore,
  type DurabilityStoredBatch,
  type DurabilityStoredJournal,
  type MemoryDurabilityStore,
  type SqliteDurabilityStoreOptions,
} from "nanocodex/durability";
import {
  createPostgresDurabilityStore,
  type PostgresDurabilityClient,
  type PostgresDurabilityPool,
  type PostgresDurabilityQueryResult,
  UnknownPostgresCommitOutcomeError,
} from "../runtime/postgres-durability-store.mjs";
import {
  createCloudflareDurabilityStore,
} from "../runtime/cloudflare-durability-store.mjs";

declare const apiKey: string;
declare const accountsWallet: AccountsWallet;
declare const browserModule: WebAssembly.Module;
declare const postgresPool: PostgresDurabilityPool;
declare const cloudflareStorage: Parameters<typeof createCloudflareDurabilityStore>[0];

// @ts-expect-error durability-only types are exported from nanocodex/durability.
type RootDurabilityStore = RootPublicTypes.DurabilityStore;
// @ts-expect-error durability-only types are exported from nanocodex/durability.
type BrowserDurabilityStore = BrowserPublicTypes.DurabilityStore;
// @ts-expect-error durability-only types are exported from nanocodex/durability.
type HostDurabilityStore = HostPublicTypes.DurabilityStore;
// @ts-expect-error durability-only types are exported from nanocodex/durability.
type NodeDurabilityStore = NodePublicTypes.DurabilityStore;

async function check() {
  const workerResource = {
    module: browserModule,
    origin: "https://example.com",
    sessionId: "session-1",
    threadId: "thread-1",
  } as const;
  await prepareWorkerAgent(workerResource);
  await createWorkerAgent(workerResource);
  // @ts-expect-error non-disabled preparation requires one stable harness identity.
  await prepareWorkerAgent({ origin: "https://example.com" });
  const parallelTool: Tool = {
    description: "Parallel read-only fixture.",
    supportsParallelToolCalls: true,
    handler: async (_input, context) => context.signal.aborted,
  };
  const parallelMcp: McpServer = {
    url: "https://mcp.example.com",
    supportsParallelToolCalls: false,
    parallelTools: ["lookup"],
  };
  // @ts-expect-error per-tool parallel safety is boolean.
  parallelTool.supportsParallelToolCalls = "yes";
  // @ts-expect-error MCP parallel allowlists contain remote tool names.
  parallelMcp.parallelTools = [1];
  const storedJournal: DurabilityStoredJournal = {
    revision: durabilityRevision(0n),
    batches: [],
  };
  const revision: DurabilityRevision = storedJournal.revision;
  const batch: DurabilityStoredBatch | undefined = storedJournal.batches[0];
  const memoryStore: MemoryDurabilityStore = createMemoryDurabilityStore("typed-memory");
  const sqliteValue: DurabilitySqliteValue = revision;
  const sqliteRow: DurabilitySqliteRow = { revision: sqliteValue };
  const sqliteQuery: DurabilitySqliteQuery = <Row extends DurabilitySqliteRow>() => [] as Row[];
  const sqliteTransaction: DurabilitySqliteTransaction = (callback) => callback(sqliteQuery);
  const sqliteOptions: SqliteDurabilityStoreOptions = { transaction: sqliteTransaction };
  void batch;
  void memoryStore;
  void sqliteOptions;
  const durabilityStore: DurabilityStore = {
    load: () => storedJournal,
    append: (_journalId: string, request: DurabilityAppendRequest): DurabilityAppendResult => ({
      status: "not_committed",
      message: `revision ${request.expectedRevision} was not committed`,
    }),
  };
  await durabilityStore.load("typed-leaf");
  const postgresStore: DurabilityStore = createPostgresDurabilityStore(postgresPool);
  const cloudflareStore: DurabilityStore = createCloudflareDurabilityStore(cloudflareStorage);
  const postgresClient: PostgresDurabilityClient = await postgresPool.connect();
  const postgresResult: PostgresDurabilityQueryResult<{ revision: string }> =
    await postgresClient.query<{ revision: string }>(
      "SELECT revision::text AS revision",
    );
  postgresClient.release(true);
  new UnknownPostgresCommitOutcomeError("typed-leaf", new Error("connection closed"));
  void postgresStore;
  void postgresResult;
  void cloudflareStore;
  const datasetOptions: DatasetOptions = { fetch: globalThis.fetch };
  leafDataset(datasetOptions);
  const nodeWorkspace = await Workspace.open({ path: "/tmp/nanocodex" });
  await nodeWorkspace.writeFile("notes.txt", "hello");
  Workspace.tools(nodeWorkspace);
  const browserWorkspace = await BrowserWorkspace.open({ name: "notebook" });
  BrowserWorkspace.tools(browserWorkspace);
  const browserEntries: readonly BrowserWorkspaceEntry[] = await browserWorkspace.list();
  const nodeEntries: readonly NodeWorkspaceEntry[] = await nodeWorkspace.list();
  void browserEntries;
  void nodeEntries;

  const agent = await Agent.create({
    transport: Transport.openAi({ apiKey }),
    filesystem: nodeWorkspace,
    model: "gpt-5.6-terra",
    thinking: "high",
    fastMode: false,
    workspace: nodeWorkspace.root,
    tools: [...Subagents.create({ maxConcurrency: 8 })],
  });
  await agent.session.compact();
  const sessionContext: AgentSessionContext = await agent.session.appendDeveloperMessage(
    "voice started",
  );
  sessionContext.history;
  const realtimeContext: AgentSessionContext = await agent.session.realtime.start();
  const realtimeDelegation: string = await agent.session.realtime.delegation("inspect the workspace", [
    { role: "user", text: "Please inspect it." },
  ]);
  const realtimeTail: string | undefined = await agent.session.realtime.tailDelegation([
    { role: "assistant", text: "I will hand this back." },
  ]);
  await agent.session.realtime.end();
  void realtimeContext;
  void realtimeDelegation;
  void realtimeTail;
  await agent.session.setFastMode(true);
  const options: Actions.turn.prompt.Options = { input: "hello" };
  const turn: Turn = agent.turn.prompt(options);
  const sameTurn: Actions.turn.prompt.ReturnType = Actions.turn.prompt(agent, options);
  const acceptedId: string | undefined = await turn.accepted();
  const sameAcceptedId: Actions.turn.accepted.ReturnType = await Actions.turn.accepted(sameTurn);
  const completed: TurnResult = await sameTurn.result();
  const sameResult: Actions.turn.getResult.ReturnType = completed;
  const message: string = completed.finalMessage;
  const snapshotPromise: Promise<SessionSnapshot> = completed.snapshot();
  const usagePromise: Promise<Actions.turn.getUsage.ReturnType> = completed.usage();
  const snapshot: Actions.turn.getSnapshot.ReturnType = await Actions.turn.getSnapshot(completed);
  const usage: Actions.turn.getUsage.ReturnType = await Actions.turn.getUsage(completed);
  usage.estimated_cost?.usd;
  const costStatus: CostStatus = usage.cost_status;
  void message;
  void acceptedId;
  void sameAcceptedId;
  void sameResult;
  void snapshotPromise;
  void usagePromise;
  void usage;
  void costStatus;

  await Agent.create({ transport: Transport.openAi({ apiKey }), resume: snapshot });
  const tempoProvider = await createTempoProviderFromAccounts({
    wallet: accountsWallet,
    accessKey: "0x0000000000000000000000000000000000000001",
    policy: { maxDeposit: "0.05", topUpAmount: "0.05" },
    session: { bootstrap: true },
  });
  await Agent.create({ transport: Transport.mpp({ session: tempoProvider }), mcp: false });
  const subscription = await ChatGptSubscription.open({
    id: "account-1",
    store: createMemoryChatGptSubscriptionStore("account-1"),
  });
  await subscription.status();
  await Agent.create({ transport: Transport.chatGpt({ subscription }) });
  // @ts-expect-error authentication belongs to the selected transport.
  await Agent.create({ transport: Transport.openAi({ apiKey }), subscription });

  const fork = await Actions.session.fork(agent, { at: completed });
  fork.turn.prompt({ input: [{ type: "text", text: "continue" }] });
  // @ts-expect-error historical forks require a completed typed result.
  await Actions.session.fork(agent, { at: turn });
  // @ts-expect-error snapshots belong to completed results, not active turns.
  turn.snapshot();
  completed.dispose();

  const watch: Actions.events.watch.Watcher = agent.events.watch();
  watch.onEvent((event) => event.payload);
  for await (const event of watch) event.seq;
  watch.off();

  const extended = agent.extend((client) => ({
    inspect: { session: () => client.sessionId },
  }));
  extended.inspect.session();
  await agent.session.shutdown();
  await Actions.session.shutdown(agent);

  // @ts-expect-error function-backed transports require the current-isolate host.
  await BrowserAgent.create({ transport: BrowserTransport.hostManaged({ createWebSocket: () => ({} as WebSocket) }) });
  await HostAgent.create({
    transport: HostTransport.hostManaged({
      websocketUrl: "wss://example.com",
      createWebSocket: () => ({} as WebSocket),
    }),
  });
  const workerTransport: BrowserTransport.WorkerTransport = BrowserTransport.hostManaged({
    websocketUrl: "wss://example.com/api/responses",
  });
  const durability = createMemoryDurabilityStore("journal-1");
  await HostAgent.create({
    transport: HostTransport.openAi({ apiKey }),
    durability,
    durabilityId: "journal-1",
  });
  // @ts-expect-error durability and durabilityId are one required pair.
  await HostAgent.create({ transport: HostTransport.openAi({ apiKey }), durability });
  // @ts-expect-error durability and durabilityId are one required pair.
  await HostAgent.create({ transport: HostTransport.openAi({ apiKey }), durabilityId: "journal-1" });
  await HostAgent.create({
    transport: HostTransport.openAi({ apiKey }),
    durability,
    durabilityId: "journal-1",
    // @ts-expect-error runtime-owned subagents cannot be reconstructed by a durable Agent.
    tools: [...BrowserSubagents.create()],
  });
  // @ts-expect-error runtime-owned subagents cannot be reconstructed by a durable Agent.
  await Agent.create({
    transport: Transport.openAi({ apiKey }),
    durability,
    durabilityId: "journal-1",
    tools: [...Subagents.create()],
  });
  // @ts-expect-error a function-valued durability store cannot cross the package Worker boundary.
  await BrowserAgent.create({ transport: workerTransport, durability, durabilityId: "journal-1" });
  const socketRequest = {} as BrowserWebSocketRequest;
  if (socketRequest.authorization === "preconnect") socketRequest.turnState;
  await BrowserAgent.create({ transport: workerTransport });
  await HostAgent.create({
    transport: HostTransport.openAi({ apiKey }),
    codeEvaluator: async (_source, environment) => {
      environment.signal.throwIfAborted();
    },
    filesystem: browserWorkspace,
    tools: [
      web({ url: "https://example.com/tools/web" }),
      dataset(),
      imageGeneration({
        url: "https://example.com/tools/images",
        recentImages: () => [],
        rememberImage: () => {},
      }),
      viewImage({ workspace: browserWorkspace }),
      updatePlan(),
      ...BrowserSubagents.create(),
    ],
  });
  const browserRuntime = await browserTools({
    threadId: "thread-1",
    origin: "https://example.com",
    web: { url: "https://example.com/tools/web" },
    images: { url: "https://example.com/tools/images" },
    dataset: { fetch: globalThis.fetch },
    recentImages: () => [],
    rememberImage: () => {},
  });
  await HostAgent.create({
    transport: HostTransport.openAi({ apiKey }),
    filesystem: browserRuntime.filesystem,
    instructions: browserRuntime.instructions,
    tools: [...browserRuntime.tools, ...BrowserSubagents.create()],
  });
  nanocodexTools().resolveId("node-rsa");
  // @ts-expect-error Rust extensions must come from a branded constructor.
  await Agent.create({ transport: Transport.openAi({ apiKey }), tools: [{ maxConcurrency: 8 }] });
  // @ts-expect-error function-backed MPP transports cannot cross the package Worker boundary.
  await BrowserAgent.create({ transport: BrowserTransport.mpp({ session: { async ws() { return {} as WebSocket; } } }) });
  await HostAgent.create({
    transport: HostTransport.mpp({ session: { async ws() { return {} as WebSocket; } } }),
  });
  // @ts-expect-error subscription handles cannot cross the package Worker boundary.
  await BrowserAgent.create({ transport: BrowserTransport.chatGpt({ subscription }) });
  await HostAgent.create({ transport: HostTransport.chatGpt({ subscription }) });
  // @ts-expect-error authentication is not an Agent.create option.
  await BrowserAgent.create({ transport: BrowserTransport.openAi({ apiKey }), hostAuth: true });
  // @ts-expect-error a transport cannot be fabricated from an arbitrary object.
  await BrowserAgent.create({ transport: { key: "fake", name: "fake", type: "fake", setup: () => ({}) } });
  await Agent.create({
    transport: Transport.mpp({ session: {
      async ws() {
        return {} as WebSocket;
      },
      async close() {},
    } }),
  });
  await Agent.create({
    transport: Transport.openAi({ apiKey }),
    module: new WebAssembly.Module(new Uint8Array()),
  });
  // @ts-expect-error transport queue policy is private to the adapter.
  await Agent.create({ transport: Transport.openAi({ apiKey }), maxQueuedMessages: 1 });
  await BrowserAgent.create({
    transport: BrowserTransport.openAi({ apiKey }),
    // @ts-expect-error browser send-buffer policy is private to the adapter.
    maxBufferedSendBytes: 1,
  });

  const rolloutSnapshot: SessionSnapshot = {
    version: 1,
    model: "gpt-5.6-sol",
    lineage_id: "thread",
    prompt_cache_key: "thread",
    workspace: "/tmp",
    canonical_context: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
    history: [],
  };
  await Agent.create({
    transport: Transport.openAi({ apiKey }),
    resume: rolloutSnapshot,
  });

  // @ts-expect-error actions are domain-grouped on the decorated Agent.
  agent.prompt("hello");
  // @ts-expect-error prompt accepts a named options bag.
  agent.turn.prompt("hello");
}

void check;
