import {
  Actions,
  Agent,
  type AccountsWallet,
  type CostStatus,
  createTempoProviderFromAccounts,
  type SessionSnapshot,
  type Turn,
  type TurnResult,
} from "../node/index.mjs";
import { Agent as BrowserAgent } from "../browser/index.mjs";

declare const apiKey: string;
declare const accountsWallet: AccountsWallet;

async function check() {
  const agent = await Agent.create({
    apiKey,
    model: "gpt-5.6-terra",
    thinking: "high",
    fastMode: false,
    workspace: "/workspace",
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

  await Agent.create({ apiKey, resume: snapshot });
  const tempoProvider = await createTempoProviderFromAccounts({
    wallet: accountsWallet,
    accessKey: "0x0000000000000000000000000000000000000001",
    policy: { maxDeposit: "0.05", topUpAmount: "0.05" },
    session: { bootstrap: true },
  });
  await Agent.create({ mpp: tempoProvider, mcp: false });

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

  await BrowserAgent.create({ websocketUrl: "wss://example.com" });
  await BrowserAgent.create({ hostAuth: true, websocketUrl: "wss://example.com" });
  await BrowserAgent.create({ apiKey });
  await BrowserAgent.create({ mpp: { async ws() { return {} as WebSocket; } } });
  // @ts-expect-error API-key and MPP authentication are mutually exclusive.
  await BrowserAgent.create({ apiKey, mpp: { async ws() { return {} as WebSocket; } } });
  // @ts-expect-error API-key and host-managed authentication are mutually exclusive.
  await BrowserAgent.create({ apiKey, hostAuth: true });
  // @ts-expect-error MPP and host-managed authentication are mutually exclusive.
  await BrowserAgent.create({ hostAuth: true, mpp: { async ws() { return {} as WebSocket; } } });
  await Agent.create({
    mpp: {
      async ws() {
        return {} as WebSocket;
      },
      async close() {},
    },
  });
  await Agent.create({ apiKey, module: new WebAssembly.Module(new Uint8Array()) });
  // @ts-expect-error transport queue policy is private to the adapter.
  await Agent.create({ apiKey, maxQueuedMessages: 1 });
  // @ts-expect-error browser send-buffer policy is private to the adapter.
  await BrowserAgent.create({ apiKey, maxBufferedSendBytes: 1 });

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
  await Agent.create({ apiKey, resume: rolloutSnapshot });

  // @ts-expect-error actions are domain-grouped on the decorated Agent.
  agent.prompt("hello");
  // @ts-expect-error prompt accepts a named options bag.
  agent.turn.prompt("hello");
}

void check;
