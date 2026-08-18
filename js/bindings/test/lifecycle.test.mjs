import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { test } from "node:test";

import { Actions } from "../index.mjs";
import { Agent } from "../node/index.mjs";
import {
  deferred,
  messageReader,
  send,
  sendCompaction,
  sendFinal,
  sendWarmup,
  startResponsesServer,
} from "./support/responses.mjs";

const SESSION_IDS = Object.freeze({
  lifecycle: "018f1f9a-7b3c-7a11-8000-000000000011",
  steer: "018f1f9a-7b3c-7a12-8000-000000000012",
  cancel: "018f1f9a-7b3c-7a13-8000-000000000013",
  compact: "018f1f9a-7b3c-7a14-8000-000000000014",
  fork: "018f1f9a-7b3c-7a15-8000-000000000015",
  reconnect: "018f1f9a-7b3c-7a16-8000-000000000016",
  shutdown: "018f1f9a-7b3c-7a17-8000-000000000017",
});

const createWarmAgent = (options) => Agent.create({
  ...options,
  websocketWarmup: true,
});

test("prompt acceptance is separate from results and healthy follow-ons reuse one socket", async () => {
  const server = await startResponsesServer();
  const firstSeen = deferred();
  const releaseFirst = deferred();
  const events = [];
  let socketClosed;
  const agent = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: server.url,
    thinking: "none",
    sessionId: SESSION_IDS.lifecycle,
  });
  const watch = agent.events.watch();
  watch.onEvent((event) => events.push(event));

  const scenario = (async () => {
    const socket = await server.nextConnection();
    socketClosed = new Promise((resolve) => socket.once("close", resolve));
    const reader = messageReader(socket);
    const warmup = await reader.next();
    assert.equal(warmup.generate, false);
    sendWarmup(socket, "resp-warmup");

    const first = await reader.next();
    assert.equal(first.previous_response_id, "resp-warmup");
    assert.match(JSON.stringify(first.input), /first owned prompt/);
    firstSeen.resolve();
    await releaseFirst.promise;
    sendFinal(socket, "resp-first", "FIRST");

    const second = await reader.next();
    assert.equal(second.previous_response_id, "resp-first");
    assert.equal(second.input.length, 1);
    assert.match(JSON.stringify(second.input), /second owned prompt/);
    assert.doesNotMatch(JSON.stringify(second.input), /first owned prompt/);
    sendFinal(socket, "resp-second", "SECOND");
  })();

  const first = agent.turn.prompt({ input: "first owned prompt" });
  assert.equal(typeof first.result, "function");
  const firstResult = first.result();
  await firstSeen.promise;
  assert.equal(
    await Promise.race([
      firstResult.then(() => "settled", () => "settled"),
      Promise.resolve("pending"),
    ]),
    "pending",
  );
  releaseFirst.resolve();
  assert.equal((await firstResult).finalMessage, "FIRST");
  assert.equal(
    (await agent.turn.prompt({ input: "second owned prompt" }).result()).finalMessage,
    "SECOND",
  );
  await scenario;
  await immediate();

  assert.equal(server.connections, 1);
  assert.ok(events.length > 2);
  assert.ok(events.every((event, index) => index === 0 || events[index - 1].seq < event.seq));
  assert.equal(events.filter(({ type }) => type === "run.completed").length, 2);

  watch.off();
  agent.dispose();
  await socketClosed;
  await server.close();
});

test("steering joins the active turn at the next model boundary", async () => {
  const server = await startResponsesServer();
  const initialSeen = deferred();
  const releaseInitial = deferred();
  const agent = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: server.url,
    thinking: "none",
    sessionId: SESSION_IDS.steer,
  });
  const scenario = (async () => {
    const socket = await server.nextConnection();
    const reader = messageReader(socket);
    await reader.next();
    sendWarmup(socket, "resp-steer-warmup");
    const initial = await reader.next();
    assert.match(JSON.stringify(initial.input), /initial task/);
    initialSeen.resolve();
    await releaseInitial.promise;
    sendFinal(socket, "resp-initial", "BOUNDARY");

    const steered = await reader.next();
    assert.equal(steered.previous_response_id, "resp-initial");
    assert.equal(steered.input.length, 1);
    assert.match(JSON.stringify(steered.input), /use the safer path/);
    sendFinal(socket, "resp-steered", "STEERED");
  })();

  const turn = agent.turn.prompt({ input: "initial task" });
  await initialSeen.promise;
  await turn.steer({ input: "use the safer path" });
  releaseInitial.resolve();
  assert.equal((await turn.result()).finalMessage, "STEERED");

  await scenario;
  agent.dispose();
  await server.close();
});

test("cancellation stops the active socket and replays only committed and aborted input", async () => {
  const server = await startResponsesServer();
  const activeSeen = deferred();
  const agent = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: server.url,
    thinking: "none",
    sessionId: SESSION_IDS.cancel,
  });
  const scenario = (async () => {
    const socket = await server.nextConnection();
    const reader = messageReader(socket);
    await reader.next();
    sendWarmup(socket, "resp-cancel-warmup");
    const active = await reader.next();
    assert.match(JSON.stringify(active.input), /cancel this work/);
    send(socket, {
      type: "response.output_text.delta",
      delta: "partial output must never commit",
    });
    activeSeen.resolve();
    await new Promise((resolve) => socket.once("close", resolve));

    const replacement = await server.nextConnection();
    const replay = await messageReader(replacement).next();
    assert.equal(replay.previous_response_id, undefined);
    const encoded = JSON.stringify(replay.input);
    assert.match(encoded, /cancel this work/);
    assert.match(encoded, /<turn_aborted>/);
    assert.match(encoded, /continue after cancellation/);
    assert.doesNotMatch(encoded, /partial output must never commit/);
    sendFinal(replacement, "resp-after-cancel", "RECOVERED");
  })();

  const cancelled = agent.turn.prompt({ input: "cancel this work" });
  await activeSeen.promise;
  await cancelled.cancel();
  await assert.rejects(cancelled.result(), /turn was cancelled/);
  assert.equal(
    (await agent.turn.prompt({ input: "continue after cancellation" }).result()).finalMessage,
    "RECOVERED",
  );

  await scenario;
  agent.dispose();
  await server.close();
});

test("graceful shutdown cancels active work and joins transport cleanup exactly once", async () => {
  const server = await startResponsesServer();
  const activeSeen = deferred();
  const socketClosed = deferred();
  const agent = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: server.url,
    thinking: "none",
    sessionId: SESSION_IDS.shutdown,
  });
  const scenario = (async () => {
    const socket = await server.nextConnection();
    socket.once("close", socketClosed.resolve);
    const reader = messageReader(socket);
    await reader.next();
    sendWarmup(socket, "resp-shutdown-warmup");
    const active = await reader.next();
    assert.match(JSON.stringify(active.input), /stop this session/);
    activeSeen.resolve();
    await socketClosed.promise;
  })();

  const turn = agent.turn.prompt({ input: "stop this session" });
  await activeSeen.promise;
  const first = agent.session.shutdown();
  const second = Actions.session.shutdown(agent);
  agent.dispose();

  await Promise.all([first, second]);
  await assert.rejects(turn.result(), /turn was cancelled/);
  await scenario;
  assert.throws(
    () => agent.turn.prompt({ input: "too late" }),
    /agent has been disposed/,
  );
  await agent.session.shutdown();
  turn.dispose();

  const replacement = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: server.url,
    thinking: "none",
    sessionId: SESSION_IDS.shutdown,
  });
  replacement.dispose();
  await server.close();
});

test("a replacement socket drops the remote response ID and replays committed history", async () => {
  const server = await startResponsesServer();
  const firstClosed = deferred();
  const agent = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: server.url,
    thinking: "none",
    sessionId: SESSION_IDS.reconnect,
  });
  const scenario = (async () => {
    const original = await server.nextConnection();
    const reader = messageReader(original);
    await reader.next();
    sendWarmup(original, "resp-reconnect-warmup");
    const first = await reader.next();
    assert.equal(first.previous_response_id, "resp-reconnect-warmup");
    sendFinal(original, "resp-before-reconnect", "BEFORE");
    original.once("close", firstClosed.resolve);
    original.terminate();

    const replacement = await server.nextConnection();
    const replay = await messageReader(replacement).next();
    assert.equal(replay.previous_response_id, undefined);
    const encoded = JSON.stringify(replay.input);
    assert.match(encoded, /before replacement/);
    assert.match(encoded, /BEFORE/);
    assert.match(encoded, /after replacement/);
    sendFinal(replacement, "resp-after-reconnect", "AFTER");
  })();

  assert.equal(
    (await agent.turn.prompt({ input: "before replacement" }).result()).finalMessage,
    "BEFORE",
  );
  await firstClosed.promise;
  assert.equal(
    (await agent.turn.prompt({ input: "after replacement" }).result()).finalMessage,
    "AFTER",
  );
  await scenario;
  assert.equal(server.connections, 2);

  agent.dispose();
  await server.close();
});

test("manual compaction and historical forks preserve exact committed boundaries", async () => {
  const server = await startResponsesServer();
  const agent = await createWarmAgent({
    apiKey: "test-key",
    websocketUrl: server.url,
    thinking: "none",
    sessionId: SESSION_IDS.compact,
  });
  const scenario = (async () => {
    const root = await server.nextConnection();
    const reader = messageReader(root);
    await reader.next();
    sendWarmup(root, "resp-history-warmup");

    const first = await reader.next();
    assert.match(JSON.stringify(first.input), /remember copper/);
    sendFinal(root, "resp-first", "stored copper");

    const second = await reader.next();
    assert.equal(second.previous_response_id, "resp-first");
    sendFinal(root, "resp-second", "stored silver");

    const compact = await reader.next();
    assert.equal(compact.previous_response_id, "resp-second");
    assert.deepEqual(compact.input, [{ type: "compaction_trigger" }]);
    sendCompaction(root, "resp-compact");

    const afterCompact = await reader.next();
    assert.equal(afterCompact.previous_response_id, undefined);
    assert.match(JSON.stringify(afterCompact.input), /opaque-js-summary/);
    assert.match(JSON.stringify(afterCompact.input), /after compaction/);
    sendFinal(root, "resp-after-compact", "COMPACTED");

    const branch = await server.nextConnection();
    const branchRequest = await messageReader(branch).next();
    assert.equal(branchRequest.previous_response_id, undefined);
    const encoded = JSON.stringify(branchRequest.input);
    assert.match(encoded, /remember copper/);
    assert.match(encoded, /stored copper/);
    assert.match(encoded, /historical branch/);
    assert.doesNotMatch(encoded, /remember silver/);
    assert.doesNotMatch(encoded, /after compaction/);
    sendFinal(branch, "resp-historical", "BRANCHED");
  })();

  const first = await agent.turn.prompt({ input: "remember copper" }).result();
  assert.equal(first.finalMessage, "stored copper");
  assert.equal(
    (await agent.turn.prompt({ input: "remember silver" }).result()).finalMessage,
    "stored silver",
  );
  await agent.session.compact();
  assert.equal(
    (await agent.turn.prompt({ input: "after compaction" }).result()).finalMessage,
    "COMPACTED",
  );

  const historical = await agent.session.fork({ at: first });
  assert.equal(
    (await historical.turn.prompt({ input: "historical branch" }).result()).finalMessage,
    "BRANCHED",
  );

  await scenario;
  historical.dispose();
  agent.dispose();
  await server.close();
});
