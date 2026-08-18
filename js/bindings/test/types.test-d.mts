import {
  Actions,
  Agent,
  ChatGptSubscription,
  type AccountsWallet,
  type CostStatus,
  createTempoProviderFromAccounts,
  createMemoryChatGptSubscriptionStore,
  Subagents,
  type SessionSnapshot,
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
import type { WorkspaceEntry as BrowserWorkspaceEntry } from "../browser/workspace.mjs";
import type { WorkspaceEntry as NodeWorkspaceEntry } from "../node/workspace.mjs";

declare const apiKey: string;
declare const accountsWallet: AccountsWallet;

async function check() {
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
  await agent.session.setFastMode(true);
  const options: Actions.turn.prompt.Options = { input: "hello" };
  const turn: Turn = agent.turn.prompt(options);
  const sameTurn: Actions.turn.prompt.ReturnType = Actions.turn.prompt(agent, options);
  const completed: TurnResult = await sameTurn.result();
  const sameResult: Actions.turn.getResult.ReturnType = completed;
  const message: string = completed.finalMessage;
  const snapshot: SessionSnapshot = completed.snapshot;
  const usage: Actions.turn.getUsage.ReturnType = completed.usage;
  usage.estimated_cost?.usd;
  const costStatus: CostStatus = usage.cost_status;
  Actions.turn.getSnapshot(completed);
  Actions.turn.getUsage(completed);
  void message;
  void sameResult;
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

  await BrowserAgent.create({
    transport: BrowserTransport.hostManaged({
      websocketUrl: "wss://example.com",
      createWebSocket: () => ({} as WebSocket),
    }),
  });
  await BrowserAgent.create({
    transport: BrowserTransport.openAi({ apiKey }),
    filesystem: browserWorkspace,
    tools: [...BrowserSubagents.create()],
  });
  // @ts-expect-error Rust extensions must come from a branded constructor.
  await Agent.create({ transport: Transport.openAi({ apiKey }), tools: [{ maxConcurrency: 8 }] });
  await BrowserAgent.create({
    transport: BrowserTransport.mpp({ session: { async ws() { return {} as WebSocket; } } }),
  });
  await BrowserAgent.create({ transport: BrowserTransport.chatGpt({ subscription }) });
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
