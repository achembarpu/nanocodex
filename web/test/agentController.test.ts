import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import {
  createAgentController,
  type AgentControllerStart,
  type AgentControllerTools,
} from "../src/agentController.ts";

const main = { pane: "main" as const, branchId: 0 };
const LIFECYCLE_BUDGET_MS = 750;
const RESET_BUDGET_MS = 500;

test("the Worker controller owns prompts, steering, cancellation, events, and cleanup", async () => {
  const harness = new AgentHarness();
  const messages: any[] = [];
  const starts: AgentControllerStart[] = [];
  const controller = createAgentController({
    async createAgent(start, tools) {
      starts.push(start);
      harness.tools = tools;
      return { agent: harness.createAgent("root") as any };
    },
    postMessage: (message) => messages.push(message),
  });

  await controller.handle({
    type: "start",
    thinking: "high",
    reasoningMode: "pro",
    transport: "openai",
  });
  assert.deepEqual(starts, [{
    thinking: "high",
    reasoningMode: "pro",
    transport: "openai",
    payerAddress: undefined,
  }]);
  assert.deepEqual(harness.watchOptions, [{ includeAllSessions: true }]);
  assert.deepEqual(messages.shift(), {
    type: "ready",
    sessionId: "root",
  });

  await controller.handle({
    type: "voiceLifecycle",
    target: main,
    id: 900,
    action: "start",
  });
  assert.deepEqual(harness.realtimeLifecycle, [{ sessionId: "root", action: "start" }]);
  assert.deepEqual(messages.shift(), {
    type: "voiceLifecycleResult",
    id: 900,
    action: "start",
    context: { workspace: "/workspace", history: [] },
  });

  harness.emit("root", event("root", 1, "run.started"));
  assert.deepEqual(messages.shift(), {
    type: "event",
    target: main,
    event: event("root", 1, "run.started"),
  });

  await controller.handle({
    type: "prompt",
    target: main,
    id: 1,
    prompt: "inspect",
    intent: "immediate",
  });
  const first = harness.turns[0]!;
  assert.equal(first.id, "1");
  assert.equal(first.input, "inspect");

  await controller.handle({
    type: "prompt",
    target: main,
    id: 2,
    prompt: "steer",
    images: ["data:image/png;base64,a"],
    intent: "immediate",
  });
  assert.deepEqual(first.steers, [{
    input: [
      { type: "image", image_url: "data:image/png;base64,a" },
      { type: "text", text: "steer" },
    ],
  }]);
  assert.deepEqual(messages.shift(), {
    type: "steerAdmitted",
    target: main,
    id: 2,
  });

  await controller.handle({ type: "cancel", target: main });
  assert.equal(first.cancelled, 1);
  assert.deepEqual(messages.shift(), {
    type: "cancelAccepted",
    target: main,
  });

  first.complete("done");
  await settle();
  assert.equal(first.disposed, 1);
  assert.deepEqual(messages.shift(), {
    type: "turnFinished",
    target: main,
    id: 1,
    message: "done",
  });

  await controller.handle({
    type: "prompt",
    target: main,
    id: 3,
    prompt: "follow on",
    intent: "queue",
  });
  const second = harness.turns[1]!;
  second.fail(new Error("model failed"));
  await settle();
  assert.deepEqual(messages.shift(), {
    type: "turnFinished",
    target: main,
    id: 3,
    error: "model failed",
  });

  await controller.handle({
    type: "artifactPrompt",
    id: 4,
    prompt: "Explain the selected chart",
  });
  assert.deepEqual(messages.shift(), {
    type: "externalPrompt",
    target: main,
    id: 4,
    prompt: "Explain the selected chart",
  });
  const artifactTurn = harness.turns[2]!;
  assert.equal(artifactTurn.input, "Explain the selected chart");
  artifactTurn.complete("explained");
  await settle();
  assert.deepEqual(messages.shift(), {
    type: "turnFinished",
    target: main,
    id: 4,
    message: "explained",
  });

  await controller.handle({
    type: "voicePrompt",
    target: main,
    id: 5,
    delegation: {
      kind: "request",
      input: "retheme the live interface",
      transcript: [{ role: "user", text: "please do it" }],
    },
  });
  assert.deepEqual(messages.shift(), {
    type: "externalPrompt",
    target: main,
    id: 5,
    prompt: "delegated:retheme the live interface:user: please do it",
    intent: "immediate",
  });
  const voiceTurn = harness.turns[3]!;
  assert.equal(voiceTurn.input, "delegated:retheme the live interface:user: please do it");
  voiceTurn.complete("rethemed");
  await settle();
  assert.deepEqual(messages.shift(), {
    type: "turnFinished",
    target: main,
    id: 5,
    message: "rethemed",
  });

  await controller.handle({
    type: "voiceTranscript",
    target: main,
    speaker: "user",
    text: "make it steampunk",
  });
  assert.deepEqual(messages.shift(), {
    type: "voiceTranscript",
    target: main,
    speaker: "user",
    text: "make it steampunk",
  });

  await controller.handle({
    type: "voiceLifecycle",
    target: main,
    id: 901,
    action: "stop",
  });
  assert.deepEqual(harness.realtimeLifecycle.at(-1), { sessionId: "root", action: "stop" });
  assert.deepEqual(messages.shift(), {
    type: "voiceLifecycleResult",
    id: 901,
    action: "stop",
    context: { workspace: "/workspace", history: [] },
  });

  await controller.dispose();
  assert.equal(harness.watchOffs, 1);
  assert.equal(harness.agents.get("root")?.disposed, 1);
  assert.equal(first.disposed, 1);
  assert.equal(second.disposed, 1);
  await assert.rejects(
    controller.handle({
      type: "prompt",
      target: main,
      id: 6,
      prompt: "late",
      intent: "queue",
    }),
    /disposed/,
  );
});

test("MPP status follows live channel receipts without duplicate UI messages", async () => {
  const harness = new AgentHarness();
  const messages: any[] = [];
  const starts: AgentControllerStart[] = [];
  let channelId: string | undefined;
  let cumulative = "0";
  const controller = createAgentController({
    async createAgent(start, tools) {
      starts.push(start);
      harness.tools = tools;
      return {
        agent: harness.createAgent("paid-root") as any,
        payment: {
          rootAddress: "0x0000000000000000000000000000000000000001",
          accessKeyAddress: () => "0x0000000000000000000000000000000000000002",
          get channelId() { return channelId; },
          cumulative: () => cumulative,
        },
      };
    },
    postMessage: (message) => messages.push(message),
  });

  await controller.handle({
    type: "start",
    thinking: "none",
    reasoningMode: "standard",
    transport: "mpp",
    accessKeyAddress: "0x0000000000000000000000000000000000000002",
    payerAddress: "0x0000000000000000000000000000000000000001",
  });
  assert.deepEqual(starts, [{
    thinking: "none",
    reasoningMode: "standard",
    transport: "mpp",
    accessKeyAddress: "0x0000000000000000000000000000000000000002",
    payerAddress: "0x0000000000000000000000000000000000000001",
  }]);
  assert.deepEqual(
    messages.filter((message) => message.type === "mppPayment").map((message) => message.payment),
    [{
      rootAddress: "0x0000000000000000000000000000000000000001",
      accessKeyAddress: "0x0000000000000000000000000000000000000002",
      channelId: undefined,
      cumulative: "0",
    }],
  );

  channelId = "0xchannel";
  cumulative = "1000";
  harness.emit("paid-root", event("paid-root", 1, "model.connection.completed"));
  harness.emit("paid-root", event("paid-root", 2, "api.event"));
  cumulative = "2000";
  harness.emit("paid-root", event("paid-root", 3, "api.event"));

  assert.deepEqual(
    messages.filter((message) => message.type === "mppPayment").map((message) => message.payment),
    [
      {
        rootAddress: "0x0000000000000000000000000000000000000001",
        accessKeyAddress: "0x0000000000000000000000000000000000000002",
        channelId: undefined,
        cumulative: "0",
      },
      {
        rootAddress: "0x0000000000000000000000000000000000000001",
        accessKeyAddress: "0x0000000000000000000000000000000000000002",
        channelId: "0xchannel",
        cumulative: "1000",
      },
      {
        rootAddress: "0x0000000000000000000000000000000000000001",
        accessKeyAddress: "0x0000000000000000000000000000000000000002",
        channelId: "0xchannel",
        cumulative: "2000",
      },
    ],
  );
  await controller.dispose();
});

test("latest and historical forks use the completed Turn boundary", async () => {
  const harness = new AgentHarness();
  const messages: any[] = [];
  const controller = createAgentController({
    async createAgent(_start, tools) {
      harness.tools = tools;
      return { agent: harness.createAgent("root") as any };
    },
    postMessage: (message) => messages.push(message),
  });
  await controller.handle({
    type: "start",
    thinking: "high",
    reasoningMode: "standard",
    transport: "openai",
  });
  messages.length = 0;

  await controller.handle({
    type: "prompt",
    target: main,
    id: 1,
    prompt: "first",
    images: Array.from(
      { length: 12 },
      (_, index) => `data:image/png;base64,${index}`,
    ),
    intent: "queue",
  });
  harness.turns[0]!.complete("one");
  await settle();
  await controller.handle({
    type: "prompt",
    target: main,
    id: 2,
    prompt: "second",
    intent: "queue",
  });
  harness.turns[1]!.complete("two");
  await settle();
  messages.length = 0;

  await controller.handle({
    type: "openBtw",
    id: 9,
    sourceBranchId: 0,
    promptId: 3,
    prompt: "side question",
    images: ["data:image/png;base64,side"],
  });
  const btw = harness.agents.get("root-fork-1")!;
  assert.equal(harness.forks[0]?.at, undefined);
  assert.deepEqual(messages.shift(), {
    type: "btwOpened",
    id: 9,
    sessionId: "root-fork-1",
  });
  assert.ok(Array.isArray(harness.turns[2]?.input));
  assert.deepEqual(harness.turns[2]?.input[0], {
    type: "image",
    image_url: "data:image/png;base64,side",
  });
  assert.match(
    String(harness.turns[2]?.input[1]?.text),
    /BTW question:\nside question/,
  );
  assert.deepEqual(
    harness.tools?.recentImages("root-fork-1", 20),
    [
      ...Array.from(
        { length: 9 },
        (_, index) => `data:image/png;base64,${index + 3}`,
      ),
      "data:image/png;base64,side",
    ],
  );
  harness.turns[2]!.complete("side");
  await settle();
  await controller.handle({ type: "closeBtw", id: 9 });
  assert.equal(btw.disposed, 1);
  assert.equal(harness.turns[2]?.disposed, 1);

  messages.length = 0;
  await controller.handle({
    type: "historicalFork",
    sourceBranchId: 0,
    newBranchId: 4,
    selectedPromptId: 2,
    newPromptId: 5,
    prompt: "replace second",
  });
  assert.equal(harness.forks[1]?.at, harness.turns[0]?.completedResult);
  assert.deepEqual(messages.shift(), {
    type: "branchOpened",
    id: 4,
    parentId: 0,
    sessionId: "root-fork-2",
  });
  assert.equal(harness.turns[3]?.input, "replace second");
  harness.turns[3]!.complete("branched");
  await settle();
  assert.deepEqual(messages.shift(), {
    type: "turnFinished",
    target: { pane: "main", branchId: 4 },
    id: 5,
    message: "branched",
  });

  await controller.dispose();
  assert.equal(harness.turns[0]?.disposed, 1);
  assert.equal(harness.turns[1]?.disposed, 1);
  assert.equal(harness.turns[3]?.disposed, 1);
});

test("restart releases active Turns and suppresses stale results and routes", async () => {
  const harness = new AgentHarness();
  const messages: any[] = [];
  let generation = 0;
  const controller = createAgentController({
    async createAgent(_start, tools) {
      harness.tools = tools;
      generation += 1;
      return { agent: harness.createAgent(`root-${generation}`) as any };
    },
    postMessage: (message) => messages.push(message),
  });
  const start = {
    type: "start" as const,
    thinking: "high" as const,
    reasoningMode: "standard" as const,
    transport: "openai" as const,
  };
  await controller.handle(start);
  await controller.handle({
    type: "prompt",
    target: main,
    id: 1,
    prompt: "retained",
    intent: "queue",
  });
  const staleTurn = harness.turns[0]!;
  messages.length = 0;

  const staleListener = harness.eventListeners.get("root-1");
  await controller.handle(start);
  assert.equal(harness.agents.get("root-1")?.disposed, 1);
  assert.equal(staleTurn.cancelled, 1);
  assert.equal(harness.turns[0]?.disposed, 1);
  assert.equal(harness.watchOffs, 1);
  staleTurn.complete("late result");
  await settle();
  staleListener?.(event("root-1", 8, "assistant.delta", { text: "stale" }));
  assert.deepEqual(messages, [{
    type: "ready",
    sessionId: "root-2",
  }]);

  await controller.dispose();
});

test("an overtaken asynchronous start cannot replace the current session", async () => {
  const harness = new AgentHarness();
  const messages: any[] = [];
  let starts = 0;
  let releaseFirst!: (value: { agent: any }) => void;
  const firstCreated = new Promise<{ agent: any }>((resolve) => {
    releaseFirst = resolve;
  });
  const controller = createAgentController({
    async createAgent(_start, tools) {
      harness.tools = tools;
      starts += 1;
      if (starts === 1) return firstCreated;
      return { agent: harness.createAgent("current") as any };
    },
    postMessage: (message) => messages.push(message),
  });
  const start = {
    type: "start" as const,
    thinking: "high" as const,
    reasoningMode: "standard" as const,
    transport: "openai" as const,
  };

  const overtaken = controller.handle(start);
  await Promise.resolve();
  await controller.handle(start);
  const stale = harness.createAgent("stale");
  releaseFirst({ agent: stale as any });
  await overtaken;

  assert.equal(stale.disposed, 1);
  assert.deepEqual(messages, [{
    type: "ready",
    sessionId: "current",
  }]);
  await controller.dispose();
});

test("controller errors stay attached to their command instead of killing the Worker", async () => {
  const harness = new AgentHarness();
  const messages: any[] = [];
  const controller = createAgentController({
    async createAgent(_start, tools) {
      harness.tools = tools;
      return { agent: harness.createAgent("root") as any };
    },
    postMessage: (message) => messages.push(message),
  });

  await controller.handle({
    type: "prompt",
    target: main,
    id: 1,
    prompt: "too early",
    intent: "queue",
  });
  assert.deepEqual(messages.shift(), {
    type: "turnFinished",
    target: main,
    id: 1,
    error: "Branch is unavailable",
  });

  await controller.handle({
    type: "start",
    thinking: "high",
    reasoningMode: "standard",
    transport: "openai",
  });
  messages.length = 0;
  harness.nextTurnResultError = new Error("result() threw synchronously");
  await controller.handle({
    type: "prompt",
    target: main,
    id: 2,
    prompt: "bad result",
    intent: "queue",
  });
  await settle();
  assert.deepEqual(messages.shift(), {
    type: "turnFinished",
    target: main,
    id: 2,
    error: "result() threw synchronously",
  });

  await controller.handle({
    type: "prompt",
    target: main,
    id: 3,
    prompt: "active",
    intent: "queue",
  });
  harness.turns[1]!.steerError = new Error("steering rejected");
  await controller.handle({
    type: "prompt",
    target: main,
    id: 4,
    prompt: "bad steer",
    intent: "immediate",
  });
  assert.deepEqual(messages.shift(), {
    type: "steerFailed",
    target: main,
    id: 4,
    error: "steering rejected",
  });

  harness.turns[1]!.complete("ignored");
  await settle();
  await controller.handle({ type: "cancel", target: main });
  assert.deepEqual(messages.at(-1), {
    type: "cancelFailed",
    target: main,
    error: "No active or queued turn",
  });
  await controller.dispose();
});

test("a large retained session releases every Turn with linear ownership", async () => {
  const harness = new AgentHarness();
  const controller = createAgentController({
    async createAgent(_start, tools) {
      harness.tools = tools;
      return { agent: harness.createAgent("root") as any };
    },
    postMessage() {},
  });
  await controller.handle({
    type: "start",
    thinking: "high",
    reasoningMode: "standard",
    transport: "openai",
  });

  const startedAt = performance.now();
  for (let id = 1; id <= 2_000; id += 1) {
    await controller.handle({
      type: "prompt",
      target: main,
      id,
      prompt: `turn ${id}`,
      intent: "queue",
    });
    harness.turns.at(-1)!.complete(`result ${id}`);
    await settle();
    assert.equal(harness.turns.at(-1)?.disposed, 1);
  }
  await controller.dispose();
  const elapsed = performance.now() - startedAt;

  assert.equal(harness.turns.length, 2_000);
  assert.equal(
    harness.turns.reduce((sum, turn) => sum + turn.disposed, 0),
    2_000,
  );
  assert.ok(
    elapsed < LIFECYCLE_BUDGET_MS,
    `2,000 completed browser turns took ${elapsed.toFixed(1)} ms`,
  );
});

test("reset cancels and releases 2,000 active Turns within the lifecycle budget", async () => {
  const harness = new AgentHarness();
  let generation = 0;
  const controller = createAgentController({
    async createAgent(_start, tools) {
      harness.tools = tools;
      generation += 1;
      return { agent: harness.createAgent(`root-${generation}`) as any };
    },
    postMessage() {},
  });
  const start = {
    type: "start" as const,
    thinking: "high" as const,
    reasoningMode: "standard" as const,
    transport: "openai" as const,
  };
  await controller.handle(start);
  for (let id = 1; id <= 2_000; id += 1) {
    await controller.handle({
      type: "prompt",
      target: main,
      id,
      prompt: `active turn ${id}`,
      intent: "queue",
    });
  }

  const startedAt = performance.now();
  await controller.handle(start);
  const elapsed = performance.now() - startedAt;

  assert.equal(harness.turns.length, 2_000);
  assert.equal(
    harness.turns.reduce((sum, turn) => sum + turn.cancelled, 0),
    2_000,
  );
  assert.equal(
    harness.turns.reduce((sum, turn) => sum + turn.disposed, 0),
    2_000,
  );
  assert.equal(harness.agents.get("root-1")?.disposed, 1);
  assert.equal(harness.agents.get("root-2")?.disposed, 0);
  assert.equal(harness.watchOffs, 1);
  assert.ok(
    elapsed < RESET_BUDGET_MS,
    `resetting 2,000 active browser turns took ${elapsed.toFixed(1)} ms`,
  );

  await controller.dispose();
  assert.equal(harness.agents.get("root-2")?.disposed, 1);
});

function event(
  request_id: string,
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
) {
  return { protocol_version: 1, request_id, seq, type, payload };
}

function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

class AgentHarness {
  agents = new Map<string, FakeAgent>();
  turns: FakeTurn[] = [];
  forks: Array<{ source: string; at?: FakeTurnResult }> = [];
  eventListeners = new Map<string, (event: any) => void>();
  watchOptions: any[] = [];
  watchOffs = 0;
  tools?: AgentControllerTools;
  nextTurnResultError?: Error;
  nextSteerError?: Error;
  realtimeLifecycle: Array<{ sessionId: string; action: "start" | "stop" }> = [];

  createAgent(sessionId: string) {
    const agent = new FakeAgent(this, sessionId);
    this.agents.set(sessionId, agent);
    return agent;
  }

  emit(sessionId: string, value: any) {
    this.eventListeners.get(sessionId)?.(value);
  }
}

class FakeAgent {
  disposed = 0;
  nextFork = 1;
  private harness: AgentHarness;
  readonly sessionId: string;
  session;
  turn;
  events;

  constructor(harness: AgentHarness, sessionId: string) {
    this.harness = harness;
    this.sessionId = sessionId;
    this.turn = {
      prompt: ({ id, input }: { id?: string; input: unknown }) => {
        const turn = new FakeTurn(
          id,
          input,
          this.harness.nextTurnResultError,
          this.harness.nextSteerError,
        );
        this.harness.nextTurnResultError = undefined;
        this.harness.nextSteerError = undefined;
        this.harness.turns.push(turn);
        return turn;
      },
    };
    this.session = {
      realtime: {
        start: async () => {
          this.harness.realtimeLifecycle.push({ sessionId: this.sessionId, action: "start" });
          return { workspace: "/workspace", history: [] };
        },
        end: async () => {
          this.harness.realtimeLifecycle.push({ sessionId: this.sessionId, action: "stop" });
          return { workspace: "/workspace", history: [] };
        },
        delegation: (input: string, transcript: Array<{ role: string; text: string }>) =>
          `delegated:${input}:${transcript.map(({ role, text }) => `${role}: ${text}`).join("\n")}`,
        tailDelegation: (transcript: Array<{ role: string; text: string }>) =>
          transcript.length ? `tail:${transcript.map(({ role, text }) => `${role}: ${text}`).join("\n")}` : undefined,
      },
      fork: async (options?: { at?: FakeTurnResult }) => {
        this.harness.forks.push({
          source: this.sessionId,
          at: options?.at,
        });
        return this.harness.createAgent(
          `${this.sessionId}-fork-${this.nextFork++}`,
        );
      },
      spawn: async () => this.harness.createAgent(
        `${this.sessionId}-spawn-${this.nextFork++}`,
      ),
      shutdown: async () => {
        this.dispose();
      },
    };
    this.events = {
      watch: (options: unknown) => {
        this.harness.watchOptions.push(options);
        return {
          onEvent: (listener: (event: any) => void) => {
            this.harness.eventListeners.set(this.sessionId, listener);
            return () => {
              if (this.harness.eventListeners.get(this.sessionId) === listener) {
                this.harness.eventListeners.delete(this.sessionId);
              }
            };
          },
          off: () => {
            this.harness.watchOffs += 1;
            this.harness.eventListeners.delete(this.sessionId);
          },
        };
      },
    };
  }

  dispose() {
    this.disposed += 1;
  }
}

class FakeTurn {
  completedResult?: FakeTurnResult;
  disposed = 0;
  cancelled = 0;
  steers: unknown[] = [];
  readonly id?: string;
  readonly input: unknown;
  private readonly resultError?: Error;
  steerError?: Error;
  private resolve!: (value: FakeTurnResult) => void;
  private reject!: (error: unknown) => void;
  private readonly completion: Promise<FakeTurnResult>;

  constructor(
    id: string | undefined,
    input: unknown,
    resultError?: Error,
    steerError?: Error,
  ) {
    this.id = id;
    this.input = input;
    this.resultError = resultError;
    this.steerError = steerError;
    this.completion = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  result() {
    if (this.resultError) throw this.resultError;
    return this.completion;
  }

  async steer(input: unknown) {
    if (this.steerError) throw this.steerError;
    this.steers.push(input);
  }

  async cancel() {
    this.cancelled += 1;
  }

  complete(value: string) {
    this.completedResult = turnResult(value, this.input);
    this.resolve(this.completedResult);
  }

  fail(error: unknown) {
    this.reject(error);
  }

  dispose() {
    this.disposed += 1;
  }
}

type FakeTurnResult = ReturnType<typeof turnResult>;

function turnResult(finalMessage: string, input: unknown) {
  return {
    finalMessage,
    snapshot: {
      version: 1,
      model: "gpt-5.6-sol",
      lineage_id: "lineage",
      prompt_cache_key: "cache",
      workspace: "/workspace",
      canonical_context: {},
      history: [input],
    },
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 2,
      estimated_cost: null,
      cost_status: "usage_not_reported",
    },
  } as const;
}
