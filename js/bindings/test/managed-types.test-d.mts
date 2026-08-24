import { Agent, ManagedError } from "nanocodex/managed";
import type {
  ManagedAgent,
  ManagedEvent,
  ManagedTurnResult,
} from "nanocodex/managed";

declare const apiKey: string;

async function checkManaged() {
  const created: ManagedAgent = await Agent.create();
  const opened: ManagedAgent = Agent.open("0198d3f0-8844-7000-8000-000000000001");
  const serverAgent = await Agent.get("0198d3f0-8844-7000-8000-000000000001", {
    baseUrl: "https://managed.example",
    apiKey,
  });
  const agents: readonly ManagedAgent[] = await Agent.list({
    baseUrl: new URL("https://managed.example"),
    apiKey,
  });
  const turn = serverAgent.turn.prompt({
    input: [{ type: "text", text: "hello" }],
    idempotencyKey: "request-1",
  });
  const accepted: string = await turn.accepted();
  const result: ManagedTurnResult = await turn.result();
  await turn.result({ signal: new AbortController().signal });
  result.finalMessage;
  result.usage?.input_tokens;
  for await (const event of serverAgent.events.watch({ cursor: result.cursor ?? "0" })) {
    const typed: ManagedEvent = event;
    typed.cursor;
    typed.data.type;
  }
  await turn.cancel();
  await created.delete();
  opened.id;
  await Agent.delete(accepted, { baseUrl: "https://managed.example", apiKey });
  new ManagedError("failed", "failed", { status: 500 });

  await Agent.create({
    // @ts-expect-error managed agents never accept provider credentials.
    providerApiKey: "sk-provider",
  });
  await Agent.create({
    // @ts-expect-error managed agents never accept runtime environments.
    env: {},
  });
}

void checkManaged;
