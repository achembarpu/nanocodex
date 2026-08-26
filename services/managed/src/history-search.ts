import type { PromptInput } from "nanocodex";

const DEFAULT_LIMIT = 8;
export const MAX_HISTORY_SEARCH_LIMIT = 20;
export const HISTORY_VECTOR_MATCH_THRESHOLD = 0.5;
const MAX_QUERY_BYTES = 4_096;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const EXACT_IDENTIFIER = /^(?=.{2,128}$)(?=.*[_:])[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u;
const HISTORY_TERM = /[\p{L}\p{N}_-]+/gu;
const HISTORY_SEARCH_STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "be", "been", "being", "did", "do", "does",
  "for", "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or",
  "our", "that", "the", "this", "to", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "with", "you", "your",
]);

export type HistoryFindSessionsInput = Readonly<{
  query: string;
  limit: number;
}>;

export type HistoryReadSessionInput = Readonly<{
  session_id: string;
  turn_ids?: readonly string[];
}>;

export type HistorySource = Readonly<{
  turn_id: string;
  cursor: string;
}>;

export type HistoryCitation = Readonly<{
  thread_id: string;
  title: string;
  sources: readonly HistorySource[];
}>;

export type HistorySearchHit = Readonly<{
  thread_id: string;
  title: string;
  turn_id: string;
  cursor: string;
  score: number;
  snippet: string;
}>;

export type HistoryFindSessionsResponse = Readonly<{
  query: string;
  results: readonly HistorySearchHit[];
  citations: readonly HistoryCitation[];
}>;

export type HistoryThreadTurn = Readonly<{
  thread_id: string;
  title: string;
  turn_id: string;
  cursor: string;
  user: string;
  assistant: string;
}>;

export type HistoryReadSessionResponse = Readonly<{
  turns: readonly HistoryThreadTurn[];
  citations: readonly HistoryCitation[];
}>;

export type HistoryProjection = Readonly<{
  thread_id: string;
  turn_id: string;
  cursor: string;
  title: string;
  input: PromptInput;
  final_message: string;
  created_at: number;
}>;

export class HistorySearchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseHistoryFindSessionsInput(value: unknown): HistoryFindSessionsInput {
  if (!isRecord(value)) {
    throw new HistorySearchError(400, "invalid_request", "session search body must be a JSON object");
  }
  if (Object.keys(value).some((key) => !["query", "limit"].includes(key))) {
    throw new HistorySearchError(400, "invalid_request", "supported fields are query and limit");
  }
  if (typeof value.query !== "string" || !value.query.trim()) {
    throw new HistorySearchError(400, "invalid_query", "query must be a non-empty string");
  }
  if (new TextEncoder().encode(value.query).byteLength > MAX_QUERY_BYTES) {
    throw new HistorySearchError(400, "invalid_query", `query must not exceed ${MAX_QUERY_BYTES} bytes`);
  }
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit)
    || Number(value.limit) < 1 || Number(value.limit) > MAX_HISTORY_SEARCH_LIMIT)) {
    throw new HistorySearchError(
      400,
      "invalid_limit",
      `limit must be an integer from 1 to ${MAX_HISTORY_SEARCH_LIMIT}`,
    );
  }
  return {
    query: value.query.trim(),
    limit: value.limit === undefined ? DEFAULT_LIMIT : Number(value.limit),
  };
}

export function parseHistoryReadSessionInput(value: unknown): HistoryReadSessionInput {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !["session_id", "turn_ids"].includes(key))) {
    throw new HistorySearchError(400, "invalid_request", "supported fields are session_id and turn_ids");
  }
  if (typeof value.session_id !== "string" || !THREAD_ID.test(value.session_id)) {
    throw new HistorySearchError(400, "invalid_session_id", "invalid session id");
  }
  if (value.turn_ids !== undefined && (!Array.isArray(value.turn_ids)
    || value.turn_ids.length > MAX_HISTORY_SEARCH_LIMIT
    || value.turn_ids.some((turnId) => typeof turnId !== "string" || !TURN_ID.test(turnId)))) {
    throw new HistorySearchError(
      400,
      "invalid_turn_ids",
      `turn_ids must contain at most ${MAX_HISTORY_SEARCH_LIMIT} valid turn ids`,
    );
  }
  return {
    session_id: value.session_id,
    ...(value.turn_ids === undefined ? {} : { turn_ids: value.turn_ids as string[] }),
  };
}

/** Exact identifiers are better served by FTS than semantic similarity. */
export function isExactHistoryIdentifierQuery(query: string): boolean {
  return EXACT_IDENTIFIER.test(query.normalize("NFKC").trim());
}

export function historyVectorRetrieval(organizationId: string, teamId: string, limit: number) {
  return {
    retrieval_type: "vector" as const,
    // AI Search applies this to vector similarity before result limiting. A
    // query with no sufficiently related memory therefore returns no direct
    // results instead of filling the response with nearest-but-irrelevant
    // turns.
    match_threshold: HISTORY_VECTOR_MATCH_THRESHOLD,
    max_num_results: Math.min(50, Math.max(limit, limit * 3)),
    filters: {
      organization_id: { $eq: organizationId },
      team_id: { $eq: teamId },
    },
    return_on_failure: false,
  };
}

export function historySearchTerms(
  query: string,
  { includeStopWords = false, maxTerms = 24 } = {},
): string[] {
  const terms = query.normalize("NFKC").match(HISTORY_TERM) ?? [];
  return [...new Set(terms.map((term) => term.toLocaleLowerCase()))]
    .filter((term) => includeStopWords || !HISTORY_SEARCH_STOP_WORDS.has(term))
    .slice(0, maxTerms);
}

export function historyFtsQuery(query: string): string {
  const terms = historySearchTerms(query, {
    includeStopWords: isExactHistoryIdentifierQuery(query),
  });
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function isAcceptedHistoryLexicalMatch(query: string, content: string): boolean {
  if (isExactHistoryIdentifierQuery(query)) {
    const identifier = query.normalize("NFKC").trim()
      .replace(/[.*+?^$\{\}()|[\]\\]/gu, "\\$&");
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}._:-])${identifier}`
        + "(?=$|[^\\p{L}\\p{N}._:-]|\\.(?=$|\\s))",
      "iu",
    ).test(content.normalize("NFKC"));
  }
  const terms = historySearchTerms(query, {
    includeStopWords: false,
  });
  if (terms.length === 0) return false;
  const contentTerms = new Set(historySearchTerms(content, {
    includeStopWords: true,
    maxTerms: Number.MAX_SAFE_INTEGER,
  }));
  for (const term of [...contentTerms]) {
    for (const part of term.split(/[_-]+/u)) {
      if (part) contentTerms.add(part);
    }
  }
  const matched = terms.reduce((count, term) => count + Number(contentTerms.has(term)), 0);
  if (terms.length === 1) return matched === 1;
  if (terms.length === 2) {
    const words = content.normalize("NFKC").toLocaleLowerCase()
      .replace(/[_-]+/gu, " ")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
    return words.some((word, index) => word === terms[0] && words[index + 1] === terms[1]);
  }
  return matched >= Math.max(2, Math.ceil(terms.length * 0.6));
}

export function groupHistoryCitations(
  results: readonly Pick<HistorySearchHit, "thread_id" | "title" | "turn_id" | "cursor">[],
): HistoryCitation[] {
  const grouped = new Map<string, { title: string; sources: HistorySource[] }>();
  for (const result of results) {
    let citation = grouped.get(result.thread_id);
    if (!citation) {
      citation = { title: result.title, sources: [] };
      grouped.set(result.thread_id, citation);
    }
    if (!citation.sources.some((source) => source.turn_id === result.turn_id
      && source.cursor === result.cursor)) {
      citation.sources.push({ turn_id: result.turn_id, cursor: result.cursor });
    }
  }
  return [...grouped].map(([thread_id, citation]) => ({ thread_id, ...citation }));
}

export function mergeHistoryCitations(
  current: readonly HistoryCitation[],
  added: readonly HistoryCitation[],
): HistoryCitation[] {
  return groupHistoryCitations([...current, ...added].flatMap((citation) => (
    citation.sources.map((source) => ({
      thread_id: citation.thread_id,
      title: citation.title,
      turn_id: source.turn_id,
      cursor: source.cursor,
    }))
  )));
}

export function promptInputText(input: PromptInput): string {
  if (typeof input === "string") return input;
  return input.flatMap((item) => {
    if (item.type === "text") return [item.text];
    if (item.type === "image") return ["[image]"];
    if (item.type === "audio") return ["[audio]"];
    return [];
  }).join("\n");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
