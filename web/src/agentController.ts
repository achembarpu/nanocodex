import type {
  AgentEvent,
  DefaultAgent,
  ReasoningMode,
  Thinking,
  Turn,
  TurnResult,
} from "nanocodex";
import type { TuiTarget } from "nanocodex-tui";

import type {
  PaymentStatus,
  WebTuiCommand,
} from "./nanocodex";
import type { Address } from "viem";

type Target = TuiTarget;

export type AgentControllerTools = {
  recentImages(sessionId: string, count: number): string[];
  rememberImage(sessionId: string, imageUrl: string): void;
};

export type AgentControllerPayment = {
  rootAddress: string;
  accessKeyAddress(): string | undefined;
  channelId?: string;
  cumulative(): string;
  mcpCumulative?(): string;
};

export type AgentControllerStart = {
  thinking: Thinking;
  reasoningMode: ReasoningMode;
  threadId?: string;
  transport: "openai" | "chatgpt" | "mpp";
  accessKeyAddress?: Address;
  payerAddress?: Address;
};

export type AgentControllerDependencies = {
  createAgent(
    start: AgentControllerStart,
    tools: AgentControllerTools,
  ): Promise<{
    agent: DefaultAgent;
    payment?: AgentControllerPayment;
  }>;
  postMessage(message: unknown): void;
  logPaymentEvent?(event: AgentEvent): void;
};

type TurnRecord = {
  turn?: Turn;
  result?: TurnResult;
  settled: boolean;
};

type Branch = {
  id: number;
  parentId?: number;
  agent: DefaultAgent;
  promptOrder: number[];
  turns: Map<number, TurnRecord>;
};

type BtwBranch = Branch & { firstPrompt: boolean };

type BrowserPromptItem =
  | { type: "image"; image_url: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "text"; text: string };

const BTW_BOUNDARY = `You are answering an ephemeral BTW side question.
Treat inherited conversation history only as reference context. Do not resume or complete an
earlier task. Answer only the question after this boundary. Do not modify the workspace unless
that side question explicitly requests a mutation.

BTW question:
`;

/**
 * Owns the browser agent lifecycle independently from the Worker transport.
 *
 * The Worker entry point supplies the real browser/WASM factory. Tests and
 * alternate hosts can supply deterministic agents without changing the
 * controller protocol.
 */
export function createAgentController({
  createAgent,
  postMessage,
  logPaymentEvent,
}: AgentControllerDependencies) {
  const routes = new Map<string, Target>();
  const branches = new Map<number, Branch>();
  const sessionImages = new Map<string, string[]>();
  let btw: BtwBranch | undefined;
  let eventWatch: ReturnType<DefaultAgent["events"]["watch"]> | undefined;
  let payment: AgentControllerPayment | undefined;
  let lastPaymentStatus: string | undefined;
  let generation = 0;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const turnReleases = new WeakMap<Turn, Promise<void>>();

  async function handle(message: WebTuiCommand): Promise<void> {
    if (disposed) throw new Error("Agent controller is disposed");
    switch (message.type) {
      case "start":
        await start({
          thinking: message.thinking,
          reasoningMode: message.reasoningMode,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          transport: message.transport,
          ...(message.transport === "mpp"
            ? { accessKeyAddress: message.accessKeyAddress }
            : {}),
          payerAddress: message.transport === "mpp" ? message.payerAddress : undefined,
        });
        return;
      case "artifactPrompt": {
        const target = { pane: "main" as const, branchId: 0 };
        postMessage({
          type: "externalPrompt",
          target,
          id: message.id,
          prompt: message.prompt,
        });
        await handle({
          type: "prompt",
          target,
          id: message.id,
          prompt: message.prompt,
          intent: "queue",
        });
        return;
      }
      case "voicePrompt": {
        postMessage({
          type: "externalPrompt",
          target: message.target,
          id: message.id,
          prompt: message.prompt,
          intent: "immediate",
        });
        await handle({
          type: "prompt",
          target: message.target,
          id: message.id,
          prompt: message.prompt,
          intent: "immediate",
        });
        return;
      }
      case "voiceTranscript":
        postMessage(message);
        return;
      case "prompt": {
        const branch = resolveTarget(message.target);
        if (!branch) {
          post("turnFinished", message.target, {
            id: message.id,
            error: "Branch is unavailable",
          });
          return;
        }
        if (message.intent === "immediate") {
          const active = firstUnsettled(branch);
          if (active) {
            try {
              const prompt = preparePrompt(branch, message.prompt);
              if (message.images?.length) {
                for (const image of message.images) {
                  rememberSessionImage(branch.agent.sessionId, image);
                }
                await active.turn.steer({
                  input: promptContent(prompt, message.images),
                });
              } else {
                await active.turn.steer({ input: prompt });
              }
              post("steerAdmitted", message.target, { id: message.id });
              return;
            } catch (error) {
              if (!errorMessage(error).includes("not active for steering")) {
                post("steerFailed", message.target, {
                  id: message.id,
                  error: errorMessage(error),
                });
                return;
              }
              post("steerQueued", message.target, {
                id: message.id,
                prompt: message.prompt,
              });
            }
          }
        }
        startTurn(
          branch,
          message.target,
          message.id,
          message.prompt,
          message.images,
        );
        return;
      }
      case "cancel": {
        const branch = resolveTarget(message.target);
        const active = branch && firstUnsettled(branch);
        if (!active) {
          post("cancelFailed", message.target, {
            error: "No active or queued turn",
          });
          return;
        }
        try {
          await active.turn.cancel();
          post("cancelAccepted", message.target);
        } catch (error) {
          post("cancelFailed", message.target, { error: errorMessage(error) });
        }
        return;
      }
      case "openBtw": {
        const main = branches.get(message.sourceBranchId);
        if (!main) throw new Error("Main branch is unavailable");
        const previous = btw;
        btw = undefined;
        if (previous) await disposeBranch(previous);
        try {
          const agent = await main.agent.session.fork();
          inheritSessionImages(main.agent.sessionId, agent.sessionId);
          btw = {
            id: message.id,
            agent,
            promptOrder: [],
            turns: new Map(),
            firstPrompt: true,
          };
          const target: Target = { pane: "btw", id: message.id };
          routes.set(agent.sessionId, target);
          postMessage({
            type: "btwOpened",
            id: message.id,
            sessionId: agent.sessionId,
          });
          if (message.prompt && message.promptId !== undefined) {
            startTurn(
              btw,
              target,
              message.promptId,
              message.prompt,
              message.images,
            );
          }
        } catch (error) {
          postMessage({
            type: "btwOpenFailed",
            id: message.id,
            error: errorMessage(error),
          });
        }
        return;
      }
      case "closeBtw": {
        if (btw?.id === message.id) {
          const closing = btw;
          btw = undefined;
          await disposeBranch(closing);
        }
        return;
      }
      case "historicalFork": {
        try {
          const source = branches.get(message.sourceBranchId);
          if (!source) throw new Error("Source branch is unavailable");
          const position = source.promptOrder.indexOf(message.selectedPromptId);
          if (position < 0) {
            throw new Error("Selected prompt is not part of this branch");
          }
          const inherited = source.promptOrder.slice(0, position);
          const previous = [...inherited]
            .reverse()
            .map((id) => source.turns.get(id))
            .find(
              (record): record is TurnRecord & { result: TurnResult } =>
                record?.result !== undefined,
            );
          const agent = previous
            ? await source.agent.session.fork({ at: previous.result })
            : await source.agent.session.spawn();
          inheritSessionImages(source.agent.sessionId, agent.sessionId);
          const branch: Branch = {
            id: message.newBranchId,
            parentId: source.id,
            agent,
            promptOrder: inherited.slice(),
            turns: new Map(
              inherited.map((id) => [id, source.turns.get(id)!]),
            ),
          };
          branches.set(branch.id, branch);
          const target: Target = {
            pane: "main",
            branchId: branch.id,
          };
          routes.set(agent.sessionId, target);
          postMessage({
            type: "branchOpened",
            id: branch.id,
            parentId: source.id,
            sessionId: agent.sessionId,
          });
          startTurn(
            branch,
            target,
            message.newPromptId,
            message.prompt,
          );
        } catch (error) {
          postMessage({
            type: "branchOpenFailed",
            id: message.newBranchId,
            error: errorMessage(error),
          });
        }
        return;
      }
    }
  }

  async function start(startOptions: AgentControllerStart): Promise<void> {
    const startGeneration = await reset();
    const created = await createAgent(startOptions, {
      recentImages(sessionId, count) {
        return (sessionImages.get(sessionId) ?? []).slice(-count);
      },
      rememberImage: rememberSessionImage,
    });
    const agent = created.agent;
    if (disposed || startGeneration !== generation) {
      await agent.session.shutdown();
      return;
    }
    payment = created.payment;
    eventWatch = agent.events.watch({ includeAllSessions: true });
    eventWatch.onEvent((event) => {
      if (disposed || startGeneration !== generation) return;
      if (payment) {
        logPaymentEvent?.(event);
        postMessage({ type: "mppJsonl", line: JSON.stringify(event) });
        postPaymentStatus();
      }
      const target = routes.get(event.request_id);
      if (target) postMessage({ type: "event", target, event });
    });
    const main: Branch = {
      id: 0,
      agent,
      promptOrder: [],
      turns: new Map(),
    };
    branches.set(0, main);
    routes.set(agent.sessionId, { pane: "main", branchId: 0 });
    postMessage({ type: "ready", sessionId: agent.sessionId });
    postPaymentStatus();
  }

  function startTurn(
    branch: Branch,
    target: Target,
    id: number,
    prompt: string,
    images: string[] = [],
  ): void {
    let turn: Turn;
    try {
      for (const image of images) {
        rememberSessionImage(branch.agent.sessionId, image);
      }
      const prepared = preparePrompt(branch, prompt);
      turn = branch.agent.turn.prompt({
        input: images.length ? promptContent(prepared, images) : prepared,
      });
    } catch (error) {
      post("turnFinished", target, { id, error: errorMessage(error) });
      return;
    }
    const record: TurnRecord = {
      turn,
      settled: false,
    };
    branch.promptOrder.push(id);
    branch.turns.set(id, record);
    void Promise.resolve()
      .then(() => turn.result())
      .then(
        (result) => {
          record.settled = true;
          record.result = result;
          if (!ownsBranch(branch)) return;
          post("turnFinished", target, {
            id,
            message: result.finalMessage,
          });
          postPaymentStatus();
        },
        (error) => {
          record.settled = true;
          if (!ownsBranch(branch)) return;
          post("turnFinished", target, {
            id,
            error: errorMessage(error),
          });
        },
      )
      .finally(() => {
        record.turn = undefined;
        releaseTurn(turn);
      });
  }

  function postPaymentStatus(): void {
    if (!payment) return;
    const status: PaymentStatus = {
      rootAddress: payment.rootAddress,
      accessKeyAddress: payment.accessKeyAddress(),
      channelId: payment.channelId,
      cumulative: payment.cumulative(),
      ...(payment.mcpCumulative
        ? { mcpCumulative: payment.mcpCumulative() }
        : {}),
    };
    const encoded = JSON.stringify(status);
    if (encoded === lastPaymentStatus) return;
    lastPaymentStatus = encoded;
    postMessage({ type: "mppPayment", payment: status });
  }

  function rememberSessionImage(sessionId: string, imageUrl: string): void {
    const images = sessionImages.get(sessionId) ?? [];
    images.push(imageUrl);
    if (images.length > 10) images.splice(0, images.length - 10);
    sessionImages.set(sessionId, images);
  }

  function inheritSessionImages(
    sourceSessionId: string,
    targetSessionId: string,
  ): void {
    const images = sessionImages.get(sourceSessionId);
    if (images?.length) sessionImages.set(targetSessionId, images.slice());
  }

  function resolveTarget(target: Target): Branch | undefined {
    return target.pane === "main"
      ? branches.get(target.branchId)
      : btw?.id === target.id
        ? btw
        : undefined;
  }

  function ownsBranch(branch: Branch): boolean {
    return ("firstPrompt" in branch && btw === branch)
      || branches.get(branch.id) === branch;
  }

  async function disposeBranch(
    branch: Branch,
    disposedTurns = new Set<Turn>(),
  ): Promise<void> {
    routes.delete(branch.agent.sessionId);
    sessionImages.delete(branch.agent.sessionId);
    const releases: Promise<void>[] = [];
    for (const record of branch.turns.values()) {
      if (!record.turn || disposedTurns.has(record.turn)) continue;
      disposedTurns.add(record.turn);
      releases.push(cancelAndReleaseTurn(record.turn));
      record.turn = undefined;
    }
    branch.turns.clear();
    await Promise.all(releases);
    await branch.agent.session.shutdown();
  }

  async function reset(): Promise<number> {
    const resetGeneration = ++generation;
    eventWatch?.off();
    eventWatch = undefined;
    const ownedBranches = [...branches.values()];
    const ownedBtw = btw;
    branches.clear();
    btw = undefined;
    routes.clear();
    sessionImages.clear();
    payment = undefined;
    lastPaymentStatus = undefined;
    const disposedTurns = new Set<Turn>();
    await Promise.all([
      ...ownedBranches.map((branch) => disposeBranch(branch, disposedTurns)),
      ...(ownedBtw ? [disposeBranch(ownedBtw, disposedTurns)] : []),
    ]);
    return resetGeneration;
  }

  function releaseTurn(turn: Turn): void {
    if (turnReleases.has(turn)) return;
    turn.dispose();
    turnReleases.set(turn, Promise.resolve());
  }

  function cancelAndReleaseTurn(turn: Turn): Promise<void> {
    const existing = turnReleases.get(turn);
    if (existing) return existing;
    const release = Promise.resolve()
      .then(() => turn.cancel())
      .catch(() => {})
      .then(() => {
        turn.dispose();
      });
    turnReleases.set(turn, release);
    return release;
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposed = true;
    disposal = reset().then(() => {});
    return disposal;
  }

  function post(
    type: string,
    target: Target,
    detail: Record<string, unknown> = {},
  ): void {
    postMessage({ type, target, ...detail });
  }

  return Object.freeze({ handle, dispose });
}

function promptContent(
  prompt: string,
  images: string[],
): BrowserPromptItem[] {
  const content: BrowserPromptItem[] = images.map((image_url) => ({
    type: "image",
    image_url,
  }));
  if (prompt) content.push({ type: "text", text: prompt });
  return content;
}

function preparePrompt(branch: Branch, prompt: string): string {
  if ("firstPrompt" in branch && branch.firstPrompt) {
    branch.firstPrompt = false;
    return BTW_BOUNDARY + prompt;
  }
  return prompt;
}

function firstUnsettled(
  branch: Branch,
): (TurnRecord & { turn: Turn }) | undefined {
  return [...branch.turns.values()].find(
    (record): record is TurnRecord & { turn: Turn } =>
      !record.settled && record.turn !== undefined,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
