import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HostedToolsBroker,
  HOSTED_TOOLS_PRE_ADMISSION_UNAVAILABLE,
  type HostedToolsBrokerContext,
  type HostedToolsBrokerPersistence,
} from "../src/hosted-tools-broker";
import {
  HOSTED_TOOLS_CAPABILITY,
  HOSTED_TOOLS_PROTOCOL_VERSION,
  MAX_HOSTED_TOOLS_FRAME_BYTES,
} from "../src/hosted-tools-protocol";

const HOST_ONE = "0190c7c6-6d2d-7a3f-8f2b-111111111111";
const HOST_TWO = "0190c7c6-6d2d-7a3f-8f2b-222222222222";
const LEASE_ONE = "11111111-1111-4111-8111-111111111111";
const LEASE_TWO = "22222222-2222-4222-8222-222222222222";
const CALL_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALL_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = 1_000_000;

const base = {
  protocol_version: HOSTED_TOOLS_PROTOCOL_VERSION,
  capability: HOSTED_TOOLS_CAPABILITY,
} as const;

type State = ReturnType<HostedToolsBrokerPersistence["state"]>;
type CallRow = NonNullable<ReturnType<HostedToolsBrokerPersistence["call"]>>;
type CallState = CallRow["state"];

afterEach(() => { vi.useRealTimers(); });

describe("HostedToolsBroker", () => {
  it("leases one authenticated-route socket, publishes atomically, and persists results before ack", async () => {
    const fixture = createFixture();
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    expect(host.sent[0]).toMatchObject({ type: "lease", generation: 1, lease_id: LEASE_ONE });

    const digest = await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry()]);
    expect(host.sent.at(-1)).toMatchObject({
      type: "catalog_ack",
      catalog_revision: 1,
      catalog_digest: digest,
    });
    expect(fixture.broker.isReady()).toBe(true);
    expect(fixture.broker.provider().resolve("tool_search")).toBeUndefined();
    expect(fixture.broker.provider().definitions().filter((definition) => definition.type === "function"))
      .toEqual([{
      ...catalogEntry().definition,
      defer_loading: true,
      }]);

    const tool = fixture.broker.provider().resolve("fixture__lookup");
    expect(tool).toMatchObject({ name: "fixture__lookup", parallelSafe: true });
    const result = tool!.handler(
      { id: "item-1" },
      { sessionId: "session:1", callId: "call:1", model: "gpt-5.6-sol" },
    );
    const call = host.sent.at(-1)!;
    const transportCallId = String(call.call_id);
    expect(call).toMatchObject({
      type: "call",
      host_id: HOST_ONE,
      lease_id: LEASE_ONE,
      generation: 1,
      catalog_revision: 1,
      session_id: "session:1",
      call_id: transportCallId,
      model: "gpt-5.6-sol",
      name: "fixture__lookup",
      input: { id: "item-1" },
    });
    expect(fixture.persistence.call(transportCallId)?.state).toBe("dispatched");

    let stateWhenAckWasSent: CallState | undefined;
    host.onSend = (frame) => {
      if (frame.type === "result_ack") stateWhenAckWasSent = fixture.persistence.call(transportCallId)?.state;
    };
    await fixture.broker.message(host.webSocket, encode({
      ...base,
      type: "result",
      lease_id: LEASE_ONE,
      generation: 1,
      catalog_revision: 1,
      call_id: transportCallId,
      outcome: { status: "completed", output: completedOutput("found") },
    }));

    expect(stateWhenAckWasSent).toBe("completed");
    expect(await result).toMatchObject({
      output: "found",
      success: true,
      structuredResult: { output: "found" },
      value: { output: "found" },
    });
    expect(host.sent.at(-1)).toMatchObject({ type: "result_ack", call_id: transportCallId });

    // A host can safely retransmit its retained receipt when the first ack was lost.
    await fixture.broker.message(host.webSocket, encode({
      ...base,
      type: "result",
      lease_id: LEASE_ONE,
      generation: 1,
      catalog_revision: 1,
      call_id: transportCallId,
      outcome: { status: "completed", output: completedOutput("found") },
    }));
    expect(host.sent.filter((frame) => frame.type === "result_ack")).toHaveLength(2);

    fixture.advance(5_000);
    await fixture.broker.message(host.webSocket, encode({
      ...base,
      type: "ping",
      lease_id: LEASE_ONE,
      generation: 1,
      nonce: "heartbeat",
    }));
    expect(host.sent.at(-1)).toMatchObject({
      type: "pong",
      expires_at: NOW + 5_000 + 60_000,
      nonce: "heartbeat",
    });
  });

  it("keeps the active catalog when a replacement acknowledgement cannot be queued", async () => {
    const fixture = createFixture();
    const active = fixture.socket();
    await attach(fixture.broker, active, HOST_ONE);
    await publish(fixture.broker, active, LEASE_ONE, 1, 1, [catalogEntry()]);

    const candidate = fixture.socket();
    await attach(fixture.broker, candidate, HOST_TWO);
    candidate.throwOnType = "catalog_ack";
    await publish(fixture.broker, candidate, CALL_ONE, 2, 1, [catalogEntry("fixture__replacement")]);

    expect(candidate.closed).toMatchObject({ code: 1008 });
    expect(fixture.persistence.state()).toMatchObject({ host_id: HOST_ONE, lease_id: LEASE_ONE, generation: 1 });
    expect(fixture.broker.provider().resolve("fixture__lookup")).toBeDefined();
  });

  it("cannot publish an obsolete candidate after the catalog digest await", async () => {
    const fixture = createFixture();
    const older = fixture.socket();
    await attach(fixture.broker, older, HOST_ONE);
    const olderTools = [catalogEntry()];
    const olderPublication = fixture.broker.message(older.webSocket, encode({
      ...base,
      type: "catalog_publish",
      lease_id: LEASE_ONE,
      generation: 1,
      catalog_revision: 1,
      catalog_digest: await catalogDigest(olderTools),
      tools: olderTools,
    }));

    const newer = fixture.socket();
    await attach(fixture.broker, newer, HOST_TWO);
    await publish(fixture.broker, newer, CALL_ONE, 2, 1, [catalogEntry("fixture__newer")]);
    await olderPublication;

    expect(fixture.persistence.state()).toMatchObject({ host_id: HOST_TWO, generation: 2 });
    expect(fixture.broker.provider().resolve("fixture__newer")).toBeDefined();
    expect(fixture.broker.provider().resolve("fixture__lookup")).toBeUndefined();
  });

  it("requires candidate revision one and bounds broker policy knobs", async () => {
    expect(() => createFixture({ maxInFlight: 65 })).toThrow(/1 through 64/);
    expect(() => createFixture({ maxCallsPerGeneration: 513 })).toThrow(/1 through 512/);
    const fixture = createFixture();
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    await publish(fixture.broker, host, LEASE_ONE, 1, 2, [catalogEntry()]);
    expect(host.closed).toMatchObject({ code: 1008 });
    expect(fixture.broker.isReady()).toBe(false);
  });

  it("enforces durable model, output budget, cancellation request, and receipt deadline pins", async () => {
    const fixture = createFixture();
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry()]);
    const tool = fixture.broker.provider().resolve("fixture__lookup")!;
    const pending = tool.handler(
      { id: "budget" },
      { sessionId: "session:pins", callId: "call:budget", model: "gpt-5.6-terra" },
    );
    const call = host.sent.findLast((frame) => frame.type === "call")!;
    const callId = String(call.call_id);
    expect(call.model).toBe("gpt-5.6-terra");
    expect(fixture.persistence.call(callId)?.model).toBe("gpt-5.6-terra");

    await fixture.broker.message(host.webSocket, cancelAck(callId, "cancelled"));
    expect(host.closed).toMatchObject({ code: 1008 });
    expect(await pending).toMatchObject({ success: false, structuredResult: { status: "ambiguous" } });

    const budgetFixture = createFixture();
    const budgetHost = budgetFixture.socket();
    await attach(budgetFixture.broker, budgetHost, HOST_ONE);
    await publish(budgetFixture.broker, budgetHost, LEASE_ONE, 1, 1, [catalogEntry()]);
    const budgetPending = budgetFixture.broker.provider().resolve("fixture__lookup")!.handler(
      { id: "small" },
      { sessionId: "session:budget", callId: "call:small", model: "gpt-5.6-sol" },
    );
    const budgetCallId = String(budgetHost.sent.findLast((frame) => frame.type === "call")!.call_id);
    budgetFixture.persistence.calls.get(budgetCallId)!.output_byte_budget = 8;
    await budgetFixture.broker.message(
      budgetHost.webSocket,
      resultFrame(budgetCallId, completedOutput("larger than eight bytes")),
    );
    expect(budgetHost.closed).toMatchObject({ code: 1008 });
    expect(await budgetPending).toMatchObject({ structuredResult: { status: "ambiguous" } });

    const deadlineFixture = createFixture();
    const deadlineHost = deadlineFixture.socket();
    await attach(deadlineFixture.broker, deadlineHost, HOST_ONE);
    await publish(deadlineFixture.broker, deadlineHost, LEASE_ONE, 1, 1, [catalogEntry()]);
    const deadlinePending = deadlineFixture.broker.provider().resolve("fixture__lookup")!.handler(
      { id: "late" },
      { sessionId: "session:deadline", callId: "call:late", model: "gpt-5.6-sol" },
    );
    const deadlineCallId = String(deadlineHost.sent.findLast((frame) => frame.type === "call")!.call_id);
    deadlineFixture.advance(30_000);
    await deadlineFixture.broker.message(
      deadlineHost.webSocket,
      resultFrame(deadlineCallId, completedOutput("late")),
    );
    expect(await deadlinePending).toMatchObject({ structuredResult: { status: "ambiguous" } });
    expect(deadlineFixture.persistence.call(deadlineCallId)).toMatchObject({ state: "ambiguous" });
  });

  it("limits WebSocket close reasons to 123 UTF-8 bytes", () => {
    const fixture = createFixture();
    const host = fixture.socket();
    fixture.broker.webSocketClose(host.webSocket, 1008, "é".repeat(100));
    expect(new TextEncoder().encode(host.closed?.reason).byteLength).toBeLessThanOrEqual(123);
  });

  it("pins prepared tools and returns unavailable instead of retargeting after catalog refresh", async () => {
    const fixture = createFixture();
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry()]);
    const old = fixture.broker.provider().resolve("fixture__lookup")!;

    await publish(fixture.broker, host, LEASE_ONE, 1, 2, [catalogEntry("fixture__lookup", false)]);
    expect(fixture.broker.provider().resolve("fixture__lookup")?.parallelSafe).toBe(false);
    const outcome = await old.handler(
      { id: "old" },
      { sessionId: "session:pin", callId: "call:stale-catalog" },
    );
    expect(outcome).toMatchObject({
      success: false,
      structuredResult: { status: "unavailable" },
    });
    // The original catalog is no longer current, but the attachment itself is
    // still present. The call durably pins that stale revision and therefore
    // cannot be retried against a cloud tool.
    expect((outcome as Record<PropertyKey, unknown>)[HOSTED_TOOLS_PRE_ADMISSION_UNAVAILABLE])
      .not.toBe(true);
    const stale = [...fixture.persistence.calls.values()].find((row) => row.session_id === "session:pin");
    expect(stale).toMatchObject({
      generation: 1,
      catalog_revision: 1,
      state: "unavailable",
    });
    expect(host.sent.filter((frame) => frame.type === "call")).toHaveLength(0);
  });

  it("maps one stable source call to one wire UUID and joins exact replays", async () => {
    const fixture = createFixture();
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry()]);
    const tool = fixture.broker.provider().resolve("fixture__lookup")!;
    const context = { sessionId: "session:replay", callId: "code/turn/tool-call" };

    const first = tool.handler({ id: "same" }, context);
    const second = tool.handler({ id: "same" }, context);
    const calls = host.sent.filter((frame) => frame.type === "call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call_id).toBe(CALL_ONE);
    expect(calls[0]?.call_id).not.toBe(context.callId);
    expect(fixture.persistence.callBySource(context.sessionId, context.callId)).toMatchObject({
      call_id: CALL_ONE,
      source_call_id: context.callId,
      state: "dispatched",
    });

    await fixture.broker.message(host.webSocket, resultFrame(CALL_ONE, completedOutput("once")));
    expect(await first).toMatchObject({ output: "once", success: true });
    expect(await second).toMatchObject({ output: "once", success: true });
    expect(await tool.handler({ id: "same" }, context)).toMatchObject({ output: "once", success: true });
    expect(host.sent.filter((frame) => frame.type === "call")).toHaveLength(1);
  });

  it("fails closed when a source call is replayed with conflicting immutable input", async () => {
    const fixture = createFixture();
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry()]);
    const tool = fixture.broker.provider().resolve("fixture__lookup")!;
    const context = { sessionId: "session:conflict", callId: "code/conflict" };
    const first = tool.handler({ id: "one" }, context);
    await fixture.broker.message(host.webSocket, resultFrame(CALL_ONE, completedOutput("done")));
    await first;

    expect(await tool.handler({ id: "two" }, context)).toMatchObject({
      success: false,
      structuredResult: { status: "ambiguous" },
    });
    expect(host.sent.filter((frame) => frame.type === "call")).toHaveLength(1);
    expect(host.sent).toContainEqual(expect.objectContaining({ type: "fenced", generation: 1 }));
    expect(host.closed).toMatchObject({ code: 1008 });
  });

  it("returns an exact retained replay after replacement without retargeting or dispatch", async () => {
    const fixture = createFixture();
    const firstHost = fixture.socket();
    await attach(fixture.broker, firstHost, HOST_ONE);
    await publish(fixture.broker, firstHost, LEASE_ONE, 1, 1, [catalogEntry()]);
    const source = { sessionId: "session:retained", callId: "code/retained" };
    const first = fixture.broker.provider().resolve("fixture__lookup")!.handler({ id: "same" }, source);
    await fixture.broker.message(firstHost.webSocket, resultFrame(CALL_ONE, completedOutput("retained")));
    await first;

    const secondHost = fixture.socket();
    await attach(fixture.broker, secondHost, HOST_TWO);
    await publish(fixture.broker, secondHost, LEASE_TWO, 2, 1, [catalogEntry()]);
    expect(await fixture.broker.provider().resolve("fixture__lookup")!.handler({ id: "same" }, source))
      .toMatchObject({ output: "retained", success: true });
    expect(secondHost.sent.filter((frame) => frame.type === "call")).toEqual([]);
    expect(secondHost.closed).toBeUndefined();
  });

  it("fences replacement generations and makes every uncertain in-flight call ambiguous", async () => {
    const fixture = createFixture();
    const first = fixture.socket();
    await attach(fixture.broker, first, HOST_ONE);
    await publish(fixture.broker, first, LEASE_ONE, 1, 1, [catalogEntry()]);
    const prepared = fixture.broker.provider().resolve("fixture__lookup")!;
    const pending = prepared.handler(
      { id: "side-effect" },
      { sessionId: "session:replace", callId: "call:replace" },
    );
    const replacementCallId = String(first.sent.findLast((frame) => frame.type === "call")!.call_id);

    const second = fixture.socket();
    await attach(fixture.broker, second, HOST_TWO);
    expect(first.sent).not.toContainEqual(expect.objectContaining({ type: "fenced" }));
    expect(fixture.broker.provider().definitions().filter((definition) => definition.type === "function"))
      .toHaveLength(1);
    await publish(fixture.broker, second, LEASE_TWO, 2, 1, [catalogEntry()]);
    expect(first.sent).toContainEqual(expect.objectContaining({
      type: "fenced",
      lease_id: LEASE_ONE,
      generation: 1,
    }));
    expect(first.closed).toMatchObject({ code: 1008 });
    expect(await pending).toMatchObject({
      success: false,
      structuredResult: { status: "ambiguous" },
    });
    expect(fixture.persistence.call(replacementCallId)?.state).toBe("ambiguous");
    expect(fixture.broker.provider().definitions().filter((definition) => definition.type === "function"))
      .toHaveLength(1);

    const stale = await prepared.handler(
      { id: "stale-after-replacement" },
      { sessionId: "session:replace", callId: "call:stale-binding" },
    );
    expect(stale).toMatchObject({ success: false, structuredResult: { status: "unavailable" } });
    expect((stale as Record<PropertyKey, unknown>)[HOSTED_TOOLS_PRE_ADMISSION_UNAVAILABLE]).toBe(true);
    expect(fixture.persistence.callBySource("session:replace", "call:stale-binding")).toBeUndefined();

    // A stale result cannot clear or retarget the new generation.
    await fixture.broker.message(first.webSocket, encode({
      ...base,
      type: "result",
      lease_id: LEASE_ONE,
      generation: 1,
      catalog_revision: 1,
      call_id: replacementCallId,
      outcome: { status: "completed", output: completedOutput("late") },
    }));
    await publish(fixture.broker, second, LEASE_TWO, 2, 2, [catalogEntry("fixture__new")]);
    expect(fixture.broker.provider().definitions()
      .filter((definition) => definition.type === "function")
      .map((definition) => definition.name))
      .toEqual(["fixture__new"]);
  });

  it("keeps the active catalog routable when a replacement candidate fails validation", async () => {
    const fixture = createFixture();
    const active = fixture.socket();
    await attach(fixture.broker, active, HOST_ONE);
    await publish(fixture.broker, active, LEASE_ONE, 1, 1, [catalogEntry()]);

    const candidate = fixture.socket();
    await attach(fixture.broker, candidate, HOST_TWO);
    await fixture.broker.message(candidate.webSocket, encode({
      ...base,
      type: "catalog_publish",
      lease_id: LEASE_TWO,
      generation: 2,
      catalog_revision: 1,
      catalog_digest: "0".repeat(64),
      tools: [catalogEntry()],
    }));

    expect(candidate.closed).toMatchObject({ code: 1008 });
    expect(active.closed).toBeUndefined();
    expect(fixture.broker.provider().definitions().map((definition) => definition.name))
      .toEqual(["fixture__lookup"]);
    expect(fixture.broker.provider().resolve("fixture__lookup")).toBeDefined();
  });

  it("rejects a ToolRouter-invalid candidate before catalog acknowledgement or replacement", async () => {
    const fixture = createFixture();
    const active = fixture.socket();
    await attach(fixture.broker, active, HOST_ONE);
    await publish(fixture.broker, active, LEASE_ONE, 1, 1, [catalogEntry()]);
    fixture.broker.provider().setCatalogValidator(() => {
      throw new Error("attached/cloud logical contract parity mismatch");
    });

    const candidate = fixture.socket();
    await attach(fixture.broker, candidate, HOST_TWO);
    await publish(fixture.broker, candidate, LEASE_TWO, 2, 1, [catalogEntry("fixture__candidate")]);

    expect(candidate.sent.some((frame) => frame.type === "catalog_ack")).toBe(false);
    expect(candidate.closed).toMatchObject({ code: 1008 });
    expect(active.closed).toBeUndefined();
    expect(fixture.broker.provider().definitions().map((definition) => definition.name))
      .toEqual(["fixture__lookup"]);
  });

  it("passes the complete behaviorally relevant catalog entry to pre-ACK validation", async () => {
    const fixture = createFixture();
    let candidate: unknown;
    fixture.broker.provider().setCatalogValidator((definitions) => {
      candidate = definitions[0];
      return true;
    });
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    const entry = catalogEntry();
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [entry]);
    expect(candidate).toEqual({
      ...entry,
      definition: { ...entry.definition, defer_loading: true },
    });
  });

  it("treats cancellation as terminal only after cancelled acknowledgement", async () => {
    const fixture = createFixture();
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry()]);

    const controller = new AbortController();
    const first = fixture.broker.provider().resolve("fixture__lookup")!.handler(
      { id: "too-late" },
      { sessionId: "session:cancel", callId: "call:too-late", signal: controller.signal },
    );
    const firstCallId = String(host.sent.findLast((frame) => frame.type === "call")!.call_id);
    controller.abort();
    expect(host.sent.at(-1)).toMatchObject({ type: "cancel", call_id: firstCallId });
    await fixture.broker.message(host.webSocket, cancelAck(firstCallId, "too_late"));
    expect(fixture.persistence.call(firstCallId)?.state).toBe("dispatched");
    await fixture.broker.message(host.webSocket, resultFrame(firstCallId, completedOutput("finished")));
    expect(await first).toMatchObject({
      output: "finished",
      success: true,
      structuredResult: { output: "finished" },
    });

    // The ordinary result can win just before the host observes the racing
    // cancellation. Its later truthful too_late acknowledgement is not a
    // protocol conflict and must not retire unrelated host authority.
    await fixture.broker.message(host.webSocket, cancelAck(firstCallId, "too_late"));
    expect(fixture.persistence.call(firstCallId)?.state).toBe("completed");
    expect(host.closed).toBeUndefined();

    const secondController = new AbortController();
    const second = fixture.broker.provider().resolve("fixture__lookup")!.handler(
      { id: "cancelled" },
      { sessionId: "session:cancel", callId: "call:cancelled", signal: secondController.signal },
    );
    const secondCallId = String(host.sent.findLast((frame) => frame.type === "call")!.call_id);
    secondController.abort();
    await fixture.broker.message(host.webSocket, cancelAck(secondCallId, "cancelled"));
    expect(await second).toMatchObject({
      success: false,
      structuredResult: { status: "cancelled" },
    });
    expect(fixture.persistence.call(secondCallId)?.state).toBe("cancelled");
  });

  it("discards exact late terminal frames after timeout without fencing the attachment", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry()]);
    const tool = fixture.broker.provider().resolve("fixture__lookup")!;

    const first = tool.handler(
      { id: "late-result" },
      { sessionId: "session:timeout", callId: "call:late-result" },
    );
    fixture.advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({ success: false, structuredResult: { status: "ambiguous" } });
    expect(fixture.persistence.call(CALL_ONE)?.state).toBe("ambiguous");
    await fixture.broker.message(host.webSocket, cancelAck(CALL_ONE, "too_late"));
    await fixture.broker.message(host.webSocket, resultFrame(CALL_ONE, completedOutput("late")));
    expect(host.sent.at(-1)).toMatchObject({ type: "result_ack", call_id: CALL_ONE });
    expect(fixture.persistence.call(CALL_ONE)).toMatchObject({
      state: "ambiguous",
      receipt_json: JSON.stringify({
        type: "result",
        outcome: { status: "completed", output: completedOutput("late") },
      }),
    });
    expect(host.closed).toBeUndefined();

    await fixture.broker.message(host.webSocket, encode({
      ...base,
      type: "ping",
      lease_id: LEASE_ONE,
      generation: 1,
      nonce: "extend",
    }));
    const second = tool.handler(
      { id: "late-cancel" },
      { sessionId: "session:timeout", callId: "call:late-cancel" },
    );
    const secondCallId = String(host.sent.findLast((frame) => frame.type === "call")?.call_id);
    fixture.advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await second).toMatchObject({ success: false, structuredResult: { status: "ambiguous" } });
    await fixture.broker.message(host.webSocket, cancelAck(secondCallId, "cancelled"));
    expect(fixture.persistence.call(secondCallId)).toMatchObject({
      state: "ambiguous",
      receipt_json: JSON.stringify({ type: "cancel_ack", outcome: "cancelled" }),
    });
    expect(host.closed).toBeUndefined();
    await fixture.broker.message(host.webSocket, resultFrame(secondCallId, completedOutput("conflict")));
    expect(host.closed).toMatchObject({ code: 1008 });
  });

  it("retires a generation before its durable receipt identity cap", async () => {
    const fixture = createFixture({ maxCallsPerGeneration: 1 });
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry()]);
    const tool = fixture.broker.provider().resolve("fixture__lookup")!;
    const first = tool.handler(
      { id: "retained" },
      { sessionId: "session:cap", callId: "call:first" },
    );
    await fixture.broker.message(host.webSocket, resultFrame(CALL_ONE, completedOutput("retained")));
    await first;

    expect(await tool.handler(
      { id: "blocked" },
      { sessionId: "session:cap", callId: "call:second" },
    )).toMatchObject({ success: false, structuredResult: { status: "unavailable" } });
    expect(fixture.persistence.call(CALL_ONE)?.state).toBe("completed");
    expect(fixture.persistence.callBySource("session:cap", "call:second")).toBeUndefined();
    expect(host.closed).toMatchObject({ code: 1008 });
  });

  it("fails closed on conflicting catalogs and oversized frames", async () => {
    const fixture = createFixture();
    const host = fixture.socket();
    await attach(fixture.broker, host, HOST_ONE);
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry()]);
    await publish(fixture.broker, host, LEASE_ONE, 1, 1, [catalogEntry("fixture__other")]);
    expect(host.sent).toContainEqual(expect.objectContaining({ type: "fenced", generation: 1 }));
    expect(fixture.broker.isReady()).toBe(false);

    const preAttach = fixture.socket();
    await fixture.broker.message(preAttach.webSocket, "x".repeat(MAX_HOSTED_TOOLS_FRAME_BYTES + 1));
    expect(preAttach.closed).toMatchObject({ code: 1008 });
  });

  it("initializes the durable schema boundary by terminalizing interrupted lifecycle rows", () => {
    const persistence = new MemoryPersistence();
    persistence.calls.set("admitted", callRow("admitted", "admitted"));
    persistence.calls.set("dispatched", callRow("dispatched", "dispatched"));
    createFixture({ persistence });
    expect(persistence.initializeCount).toBe(1);
    expect(persistence.call("admitted")).toMatchObject({ state: "unavailable" });
    expect(persistence.call("dispatched")).toMatchObject({ state: "ambiguous" });
  });

  it("retires restored authority and fences hibernated sockets on lifecycle restart", () => {
    const persistence = new MemoryPersistence();
    persistence.current = {
      generation: 7,
      host_id: HOST_ONE,
      lease_id: LEASE_ONE,
      lease_expires_at: NOW + 60_000,
      catalog_revision: 3,
      catalog_digest: "digest",
      catalog_json: JSON.stringify([catalogEntry()]),
    };
    persistence.calls.set("admitted", callRow("admitted", "admitted"));
    persistence.calls.set("dispatched", callRow("dispatched", "dispatched"));
    const restored = new FakeSocket();
    restored.serializeAttachment({
      kind: "hosted-tools",
      sessionId: "session:route",
      hostId: HOST_ONE,
      leaseId: LEASE_ONE,
      generation: 7,
    });

    const fixture = createFixture({ persistence, sockets: [restored] });
    expect(fixture.persistence.current).toMatchObject({
      generation: 7,
      host_id: null,
      lease_id: null,
      catalog_revision: null,
    });
    expect(restored.sent).toEqual([]);
    expect(restored.closed).toMatchObject({ code: 1012 });
    expect(fixture.broker.isReady()).toBe(false);
    expect(persistence.call("admitted")?.state).toBe("unavailable");
    expect(persistence.call("dispatched")?.state).toBe("ambiguous");
  });
});

function createFixture(options: {
  persistence?: MemoryPersistence;
  maxInFlight?: number;
  maxCallsPerGeneration?: number;
  sockets?: FakeSocket[];
} = {}) {
  const persistence = options.persistence ?? new MemoryPersistence();
  const sockets = options.sockets ?? [];
  let now = NOW;
  const leaseIds = [LEASE_ONE, CALL_ONE, LEASE_TWO, CALL_TWO];
  const context = {
    storage: {} as DurableObjectStorage,
    acceptWebSocket() {},
    getWebSockets: () => sockets.map((socket) => socket.webSocket),
  } as unknown as HostedToolsBrokerContext;
  const broker = new HostedToolsBroker(context, {
    persistence,
    now: () => now,
    randomUUID: () => leaseIds.shift() ?? "33333333-3333-4333-8333-333333333333",
    maxInFlight: options.maxInFlight,
    maxCallsPerGeneration: options.maxCallsPerGeneration,
  });
  return {
    broker,
    persistence,
    advance(milliseconds: number) { now += milliseconds; },
    socket() {
      const socket = new FakeSocket();
      socket.serializeAttachment({ kind: "hosted-tools", sessionId: "session:route" });
      sockets.push(socket);
      return socket;
    },
  };
}

class FakeSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed?: { code: number; reason: string };
  onSend?: (frame: Record<string, unknown>) => void;
  throwOnType?: string;
  #attachment: unknown;
  readyState = WebSocket.OPEN;

  readonly webSocket = this as unknown as WebSocket;

  serializeAttachment(value: unknown): void { this.#attachment = structuredClone(value); }
  deserializeAttachment(): unknown { return structuredClone(this.#attachment); }
  send(encoded: string): void {
    const frame = JSON.parse(encoded) as Record<string, unknown>;
    if (frame.type === this.throwOnType) throw new Error(`injected ${this.throwOnType} send failure`);
    this.onSend?.(frame);
    this.sent.push(frame);
  }
  close(code: number, reason: string): void {
    this.readyState = WebSocket.CLOSED;
    this.closed = { code, reason };
  }
}

class MemoryPersistence implements HostedToolsBrokerPersistence {
  initializeCount = 0;
  current: State = {
    generation: 0,
    host_id: null,
    lease_id: null,
    lease_expires_at: 0,
    catalog_revision: null,
    catalog_digest: null,
    catalog_json: null,
  };
  readonly calls = new Map<string, CallRow>();

  initialize(_now: number): State | undefined {
    this.initializeCount += 1;
    const retired = this.current.lease_id ? structuredClone(this.current) : undefined;
    for (const row of this.calls.values()) {
      if (row.state === "admitted") {
        row.state = "unavailable";
        row.result_json = JSON.stringify({ status: "unavailable", message: "lifecycle restart" });
      } else if (row.state === "dispatched") {
        row.state = "ambiguous";
        row.result_json = JSON.stringify({ status: "ambiguous", message: "lifecycle restart" });
      }
    }
    if (this.current.lease_id) this.clearHost(this.current.lease_id, this.current.generation);
    return retired;
  }
  transaction<T>(callback: () => T): T { return callback(); }
  state(): State { return structuredClone(this.current); }
  replaceHost(row: State): void { this.current = structuredClone(row); }
  clearHost(leaseId: string, generation: number): void {
    if (this.current.lease_id !== leaseId || this.current.generation !== generation) return;
    this.current = {
      ...this.current,
      host_id: null,
      lease_id: null,
      lease_expires_at: 0,
      catalog_revision: null,
      catalog_digest: null,
      catalog_json: null,
    };
  }
  publishCatalog(
    leaseId: string,
    generation: number,
    revision: number,
    digest: string,
    catalogJson: string,
  ): void {
    if (this.current.lease_id !== leaseId || this.current.generation !== generation) return;
    this.current = {
      ...this.current,
      catalog_revision: revision,
      catalog_digest: digest,
      catalog_json: catalogJson,
    };
  }
  call(callId: string): CallRow | undefined {
    const row = this.calls.get(callId);
    return row && structuredClone(row);
  }
  callBySource(sessionId: string, sourceCallId: string): CallRow | undefined {
    const row = [...this.calls.values()].find((candidate) => candidate.session_id === sessionId
      && candidate.source_call_id === sourceCallId);
    return row && structuredClone(row);
  }
  insertCall(row: CallRow): void {
    if (this.calls.has(row.call_id)) throw new Error("duplicate call");
    if (this.callBySource(row.session_id, row.source_call_id)) throw new Error("duplicate source call");
    this.calls.set(row.call_id, structuredClone(row));
  }
  markCancelRequested(callId: string): CallRow | undefined {
    const row = this.calls.get(callId);
    if (row?.state === "dispatched") row.cancel_requested = 1;
    return this.call(callId);
  }
  transitionCall(
    callId: string,
    from: readonly CallState[],
    state: CallState,
    resultJson: string,
  ): CallRow | undefined {
    const row = this.calls.get(callId);
    if (row && from.includes(row.state)) {
      row.state = state;
      row.result_json = resultJson || null;
    }
    return this.call(callId);
  }
  recordLateReceipt(callId: string, receiptJson: string): CallRow | undefined {
    const row = this.calls.get(callId);
    if (row?.state === "ambiguous" && row.receipt_json === null) row.receipt_json = receiptJson;
    return this.call(callId);
  }
  markGenerationAmbiguous(leaseId: string, generation: number, resultJson: string): void {
    for (const row of this.calls.values()) {
      if (row.lease_id === leaseId && row.generation === generation && row.state === "dispatched") {
        row.state = "ambiguous";
        row.result_json = resultJson;
      }
    }
  }
  activeCallCount(leaseId: string, generation: number): number {
    return [...this.calls.values()].filter((row) => row.lease_id === leaseId
      && row.generation === generation
      && (row.state === "admitted" || row.state === "dispatched")).length;
  }
  generationCallCount(leaseId: string, generation: number): number {
    return [...this.calls.values()].filter((row) => row.lease_id === leaseId
      && row.generation === generation).length;
  }
  pruneReceipts(activeLeaseId: string | null, activeGeneration: number, limit: number): void {
    const retired = [...this.calls.values()]
      .filter((row) => row.state !== "admitted" && row.state !== "dispatched"
        && !(row.lease_id === activeLeaseId && row.generation === activeGeneration))
      .sort((left, right) => right.call_id.localeCompare(left.call_id));
    for (const row of retired.slice(limit)) this.calls.delete(row.call_id);
  }
}

async function attach(broker: HostedToolsBroker, socket: FakeSocket, hostId: string): Promise<void> {
  await broker.message(socket.webSocket, encode({
    ...base,
    type: "attach",
    host_id: hostId,
    capabilities: [{ name: "tools", version: 1 }],
  }));
}

async function publish(
  broker: HostedToolsBroker,
  socket: FakeSocket,
  leaseId: string,
  generation: number,
  revision: number,
  tools: ReturnType<typeof catalogEntry>[],
): Promise<string> {
  const digest = await catalogDigest(tools);
  await broker.message(socket.webSocket, encode({
    ...base,
    type: "catalog_publish",
    lease_id: leaseId,
    generation,
    catalog_revision: revision,
    catalog_digest: digest,
    tools,
  }));
  return digest;
}

function catalogEntry(name = "fixture__lookup", parallelSafe = true) {
  return {
    provider: "fixture",
    remote_name: name,
    definition: {
      type: "function" as const,
      name,
      description: "Look up one fixture by identifier.",
      strict: true,
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    parallel_safe: parallelSafe,
    summary: "Fixture lookup.",
    timeout_ms: 30_000,
  };
}

function completedOutput(output: string) {
  return {
    output,
    success: true,
    structured_result: { output },
    metadata: null,
    process_trace: null,
  };
}

function resultFrame(callId: string, output: ReturnType<typeof completedOutput>): string {
  return encode({
    ...base,
    type: "result",
    lease_id: LEASE_ONE,
    generation: 1,
    catalog_revision: 1,
    call_id: callId,
    outcome: { status: "completed", output },
  });
}

function cancelAck(callId: string, outcome: "cancelled" | "too_late"): string {
  return encode({
    ...base,
    type: "cancel_ack",
    lease_id: LEASE_ONE,
    generation: 1,
    catalog_revision: 1,
    call_id: callId,
    outcome,
  });
}

function callRow(callId: string, state: "admitted" | "dispatched"): CallRow {
  return {
    call_id: callId,
    session_id: "session:lifecycle",
    source_call_id: `source:${callId}`,
    host_id: HOST_ONE,
    lease_id: LEASE_ONE,
    generation: 1,
    catalog_revision: 1,
    model: "gpt-5.6-sol",
    name: "fixture__lookup",
    input_json: "{}",
    output_token_budget: 1_000,
    output_byte_budget: 1_000,
    deadline_at: NOW + 1_000,
    cancel_requested: 0,
    state,
    result_json: null,
    receipt_json: null,
  };
}

function encode(value: unknown): string { return JSON.stringify(value); }

async function catalogDigest(tools: unknown): Promise<string> {
  const canonical = JSON.stringify(canonicalValue(tools));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`nanocodex-hosted-tools-catalog-v1\0${canonical}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, canonicalValue(child)]));
}

