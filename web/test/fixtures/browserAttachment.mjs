import { createTools } from "nanocodex/tools";

const base = { protocol_version: 1, capability: "tools" };
const leaseId = "22222222-2222-4222-8222-222222222222";

async function main() {
  try {
    const native = await exercise(false);
    const cloudflare = await exercise(true);
    document.body.dataset.state = "passed";
    document.body.dataset.result = JSON.stringify({ ok: true, native, cloudflare });
  } catch (error) {
    document.body.dataset.state = "failed";
    document.body.dataset.result = JSON.stringify({
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}

async function exercise(cloudflare) {
  const label = cloudflare ? "cloudflare" : "native";
  const socket = new FakeSocket(cloudflare);
  const tools = await createTools({
    tools: {
      echo: {
        description: "Echo one browser value.",
        strict: true,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        handler: ({ value }) => `browser:${value}`,
      },
    },
  });
  const connector = tools.attach({
    endpoint: "wss://managed.invalid/tools",
    transport: { connect: async () => socket },
  }, { reconnect: false });
  const connecting = connector.connect();
  document.body.dataset.stage = `${label}:attach`;
  await waitFor(() => socket.frame("attach"));
  socket.receive({
    ...base,
    type: "lease",
    lease_id: leaseId,
    generation: 7,
    expires_at: Date.now() + 60_000,
    capabilities: [{ name: "tools", version: 1 }],
  });
  document.body.dataset.stage = `${label}:catalog`;
  await waitFor(() => socket.frame("catalog_publish"));
  const catalog = socket.frame("catalog_publish");
  socket.receive({
    ...base,
    type: "catalog_ack",
    lease_id: leaseId,
    generation: 7,
    catalog_revision: 1,
    catalog_digest: catalog.catalog_digest,
  });
  const attachment = await connecting;
  socket.receive({
    ...base,
    type: "call",
    host_id: socket.frame("attach").host_id,
    lease_id: leaseId,
    generation: 7,
    catalog_revision: 1,
    call_id: "browser-call",
    name: "echo",
    input: { value: cloudflare ? "cloudflare" : "native" },
    model: "gpt-5.6-sol",
    session_id: "browser-session",
    deadline_at: Date.now() + 10_000,
    output_token_budget: 10_000,
    output_byte_budget: 8_192,
  });
  document.body.dataset.stage = `${label}:result`;
  await waitFor(() => socket.frame("result"));
  const output = socket.frame("result").outcome.output.output;
  const firstClosed = attachment.closed();
  const secondClosed = attachment.closed();
  if (firstClosed !== secondClosed) throw new Error("closed() did not retain terminal identity");
  document.body.dataset.stage = `${label}:close`;
  await attachment.close();
  await connector.close();
  await tools.close();
  return { output, closeCalls: socket.closeCalls };
}

class FakeSocket extends EventTarget {
  constructor(cloudflare) {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = 0;
    if (cloudflare) this.accept = () => {};
    setTimeout(() => this.dispatchEvent(new Event("open")), 0);
  }

  send(encoded) {
    this.sent.push(JSON.parse(encoded));
  }

  frame(type) {
    return this.sent.find((frame) => frame.type === type);
  }

  receive(frame) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 2;
    if (typeof this.accept !== "function") {
      queueMicrotask(() => {
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
      });
    }
  }
}

async function waitFor(predicate) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("browser attachment smoke timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

void main();

