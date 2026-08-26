const baseUrl = process.env.NANOCODEX_BASE_URL?.replace(/\/$/, "");
const fixtureUrl = process.env.NANOCODEX_FIXTURE_URL?.replace(/\/$/, "");
const fixtureToken = process.env.NANOCODEX_FIXTURE_TOKEN;
if (!baseUrl?.startsWith("https://")) {
  throw new Error("NANOCODEX_BASE_URL must be an HTTPS Worker origin");
}
if (!fixtureUrl?.startsWith("https://") || !fixtureToken) {
  throw new Error("NANOCODEX_FIXTURE_URL and NANOCODEX_FIXTURE_TOKEN are required");
}

const stories = [
  ["target", "During lunar maintenance, the cobalt heron team keeps the emergency deployment credential beneath floorboard nineteen in the north observatory. The backup confirmation phrase is velvet rain. The release record is release:artifact_42."],
  ["near-bird", "The cobalt heron team archives annual tax ledgers beneath floorboard nineteen in the north observatory. Emergency credentials are not discussed in this record."],
  ["near-action", "During lunar maintenance, the amber crane team keeps the emergency deployment credential beneath floorboard nineteen in the north observatory."],
  ["near-place", "During lunar maintenance, the cobalt heron team keeps the emergency deployment credential inside rooftop cabinet seven at the south observatory."],
  ["near-time", "During solar calibration, the cobalt heron team keeps an emergency radio battery beneath floorboard nineteen in the north observatory."],
  ["mars", "The vermilion fox expedition stores a pressure seal map behind the third mosaic in the Mars habitat kitchen."],
  ["ocean", "The silver otter vessel records ballast overrides in a green notebook locked beside the aft sonar console."],
  ["orchard", "The orchard cooperative schedules frost alarms after midnight and keeps irrigation maps in the west barn."],
  ["library", "The midnight library's rare atlas is checked out only with a brass token kept at the circulation desk."],
  ["rail", "The alpine railway uses an orange flag to authorize tunnel inspections after the final passenger service."],
  ["medical", "The clinic's backup vaccine refrigerator is powered by generator circuit delta during planned grid work."],
];
const requestedStoryLimit = Number(process.env.NANOCODEX_STORY_LIMIT ?? stories.length);
if (!Number.isSafeInteger(requestedStoryLimit)
  || requestedStoryLimit < 1 || requestedStoryLimit > stories.length) {
  throw new Error("NANOCODEX_STORY_LIMIT is outside the available corpus");
}
const selectedStories = stories.slice(0, requestedStoryLimit);
const convergenceMs = Number(process.env.NANOCODEX_CONVERGENCE_MS ?? 90_000);
if (!Number.isSafeInteger(convergenceMs) || convergenceMs < 1_000 || convergenceMs > 180_000) {
  throw new Error("NANOCODEX_CONVERGENCE_MS must be from 1000 to 180000");
}

const ambiguousQuery = "Where is the urgent rollout password hidden while the moon observatory is being serviced?";
const semanticQuery = "Which secret did the blue waterbird crew hide under plank nineteen in the northern stargazing station during moon servicing?";
const exactQuery = "release:artifact_42";
const irrelevantQuery = "neon penguin saxophone wedding";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, fraction) => values.toSorted((a, b) => a - b)[
  Math.min(values.length - 1, Math.floor(values.length * fraction))
];

async function account(label) {
  const meResponse = await fetch(baseUrl + "/v1/me");
  const cookie = meResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!meResponse.ok || !cookie) throw new Error("account bootstrap failed");
  const me = await meResponse.json();
  const keyResponse = await fetch(baseUrl + "/v1/api-keys", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  const key = await keyResponse.json();
  if (!keyResponse.ok) throw new Error("API key creation failed with HTTP " + keyResponse.status);
  return { cookie, keyId: key.key.id, token: key.api_key, me, threads: [] };
}

async function api(subject, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer " + subject.token);
  const response = await fetch(baseUrl + path, { ...init, headers });
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
}

function uuidV7Fixture() {
  const id = crypto.randomUUID();
  return id.slice(0, 14) + "7" + id.slice(15);
}

async function fixtures(subject, operation, values, verifyQuery) {
  const request = {
    method: "POST",
    headers: {
      authorization: "Bearer " + fixtureToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      organization_id: subject.me.organization.id,
      team_id: subject.me.team.id,
      operation,
      ...(verifyQuery === undefined ? {} : { verify_query: verifyQuery }),
      ...(operation === "project" ? { projections: values } : { thread_ids: values }),
    }),
  };
  let response;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    response = await fetch(fixtureUrl, request);
    if (response.status !== 404 || attempt === 9) break;
    await sleep(500 * (attempt + 1));
  }
  if (!response.ok) throw new Error("fixture " + operation + " failed with HTTP " + response.status);
  return response.json();
}

async function find(subject, query) {
  const started = performance.now();
  const { response, body } = await api(subject, "/v1/history/sessions/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, limit: 8 }),
  });
  return { status: response.status, body, elapsedMs: performance.now() - started };
}

async function converge(subject, query, predicate) {
  const deadline = Date.now() + convergenceMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await find(subject, query);
    if (latest.status === 200 && predicate(latest.body)) return latest;
    await sleep(2_000);
  }
  throw new Error("search did not converge: " + JSON.stringify(latest?.body));
}

async function cleanup(subject) {
  if (!subject) return;
  const failures = [];
  if (subject.threads.length > 0) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await fixtures(subject, "delete", subject.threads).then(() => true, () => false)) break;
      if (attempt === 4) failures.push(...subject.threads);
      await sleep(250 * (attempt + 1));
    }
  }
  const revoked = await fetch(baseUrl + "/v1/api-keys/" + subject.keyId, {
    method: "DELETE",
    headers: { cookie: subject.cookie, origin: baseUrl },
  }).catch(() => undefined);
  if (failures.length > 0 || (revoked && ![204, 404].includes(revoked.status))) {
    console.error(JSON.stringify({ cleanupFailures: failures.length, keyStatus: revoked?.status }));
  }
}

let primary;
let isolated;
const report = { baseUrl };
try {
  primary = await account("hosted-history-stress-primary");
  const projectionStarted = performance.now();
  const turns = selectedStories.map(([name, story], index) => ({
    agentId: uuidV7Fixture(),
    name,
    turnId: "story-" + name,
    projection: {
      thread_id: undefined,
      turn_id: "story-" + name,
      cursor: String(index + 1),
      title: "Hosted history fixture " + name,
      input: "Retain this fictional test story accurately:\n\n" + story,
      final_message: "The fictional " + name + " story was retained for this test.",
      created_at: Date.now() + index,
    },
  }));
  for (const turn of turns) turn.projection.thread_id = turn.agentId;
  primary.threads.push(...turns.map((turn) => turn.agentId));
  const projected = await fixtures(
    primary,
    "project",
    turns.map((turn) => turn.projection),
    exactQuery,
  );
  if (!projected.verification?.results?.some((result) => result.thread_id === turns[0].agentId)) {
    throw new Error("projected fixture was not immediately searchable inside MemoryScope: "
      + JSON.stringify(projected.verification));
  }
  report.projectionWave = {
    count: turns.length,
    elapsedMs: Math.round(performance.now() - projectionStarted),
  };

  const target = turns.find((turn) => turn.name === "target");
  const exact = await converge(primary, exactQuery, (body) => (
    body.results?.some((result) => result.session_id === target.agentId)
  ));
  const semantic = await converge(primary, semanticQuery, (body) => (
    body.results?.[0]?.session_id === target.agentId
  ));
  const ambiguous = await find(primary, ambiguousQuery);
  const irrelevant = await find(primary, irrelevantQuery);
  if (irrelevant.status !== 200 || irrelevant.body.results.length !== 0) {
    throw new Error("irrelevant query returned a false positive: "
      + JSON.stringify(irrelevant.body));
  }

  const exactHit = exact.body.results.find((result) => result.session_id === target.agentId);
  if (!exact.body.citations.some((citation) => citation.thread_id === target.agentId)) {
    throw new Error("exact result omitted its citation");
  }
  const read = await api(
    primary,
    "/v1/history/sessions/" + target.agentId + "/read",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_ids: [target.turnId] }),
    },
  );
  if (read.response.status !== 200 || !read.body.turns?.[0]?.user.includes("floorboard nineteen")) {
    throw new Error("exact history read did not rehydrate the source turn");
  }

  isolated = await account("hosted-history-stress-isolated");
  const crossTenant = await find(isolated, exactQuery);
  if (crossTenant.status !== 200 || crossTenant.body.results.length !== 0) {
    throw new Error("cross-organization history leaked");
  }

  const probes = Array.from({ length: 48 }, (_, index) => (
    index % 3 === 0 ? exactQuery : index % 3 === 1 ? semanticQuery : irrelevantQuery
  ));
  const stressStarted = performance.now();
  const stressed = await Promise.all(probes.map((query) => find(primary, query)));
  const latencies = stressed.map((result) => result.elapsedMs);
  if (stressed.some((result) => result.status !== 200)) throw new Error("concurrent search returned non-200");
  if (stressed.some((result, index) => probes[index] === exactQuery
    && !result.body.results.some((hit) => hit.session_id === target.agentId))) {
    throw new Error("concurrent exact search lost the target");
  }
  if (stressed.some((result, index) => probes[index] === semanticQuery
    && result.body.results[0]?.session_id !== target.agentId)) {
    throw new Error("concurrent semantic search changed its winner");
  }
  if (stressed.some((result, index) => probes[index] === irrelevantQuery
    && result.body.results.length !== 0)) {
    throw new Error("concurrent irrelevant search returned a false positive");
  }

  report.search = {
    exact: { elapsedMs: Math.round(exact.elapsedMs), score: exactHit.score },
    semantic: {
      elapsedMs: Math.round(semantic.elapsedMs),
      winner: semantic.body.results[0],
      resultCount: semantic.body.results.length,
    },
    ambiguous: {
      elapsedMs: Math.round(ambiguous.elapsedMs),
      ranking: ambiguous.body.results.slice(0, 5).map((result) => ({
        title: result.title,
        score: result.score,
      })),
    },
    irrelevantResultCount: irrelevant.body.results.length,
    crossTenantResultCount: crossTenant.body.results.length,
  };
  report.concurrency = {
    requests: stressed.length,
    wallMs: Math.round(performance.now() - stressStarted),
    p50Ms: Math.round(percentile(latencies, 0.50)),
    p95Ms: Math.round(percentile(latencies, 0.95)),
    maxMs: Math.round(Math.max(...latencies)),
  };

  await fixtures(primary, "delete", [target.agentId]);
  primary.threads = primary.threads.filter((threadId) => threadId !== target.agentId);
  const tombstoned = await converge(primary, exactQuery, (body) => (
    !body.results.some((result) => result.session_id === target.agentId)
  ));
  report.tombstone = {
    converged: true,
    residualTarget: tombstoned.body.results.some((result) => result.session_id === target.agentId),
  };
  console.log(JSON.stringify(report));
} finally {
  await Promise.all([cleanup(primary), cleanup(isolated)]);
}
