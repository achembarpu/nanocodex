import type { Workspace, WorkspaceEntry } from "nanocodex/browser/workspace";
import type { VoiceSessionContext } from "nanocodex-tui";

/** One completed browser Realtime transcript entry. */
export type VoiceTranscriptEntry = { role: "user" | "assistant"; text: string };

const CURRENT_THREAD_BUDGET = 1_200;
const WORKSPACE_BUDGET = 1_600;
const NOTES_BUDGET = 300;
const TOTAL_BUDGET = 5_300;
const TURN_BUDGET = 300;
const APPROX_BYTES_PER_TOKEN = 4;
const TREE_DEPTH = 2;
const TREE_ENTRIES = 20;
const WORKSPACE_LIST_LIMIT = 2_000;
const NOISY_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
]);

export async function browserVoiceStartupContext(
  context: VoiceSessionContext,
  workspace?: Workspace,
): Promise<string | undefined> {
  const current = currentThread(context.history);
  const workspaceContext = workspace
    ? await workspaceMap(context.workspace, workspace).catch(() => undefined)
    : undefined;
  if (!current && !workspaceContext) return undefined;

  const parts = [
    "Startup context from Codex.\nThis is background context about recent work and machine/workspace layout. It may be incomplete or stale. Use it to inform responses, and do not repeat it back unless relevant.",
  ];
  section(parts, "Current Thread", current, CURRENT_THREAD_BUDGET);
  section(parts, "Machine / Workspace Map", workspaceContext, WORKSPACE_BUDGET);
  section(
    parts,
    "Notes",
    "Built at realtime startup from the current thread history and a bounded browser workspace scan. This excludes repo memory instructions, AGENTS files, project-doc prompt blends, and memory summaries.",
    NOTES_BUDGET,
  );
  return truncate(`<startup_context>\n${parts.join("\n\n")}\n</startup_context>`, TOTAL_BUDGET);
}

function currentThread(history: readonly Record<string, unknown>[]): string | undefined {
  const turns: Array<{ user: string[]; assistant: string[] }> = [];
  let user: string[] = [];
  let assistant: string[] = [];
  for (const item of history) {
    if (item.type !== "message") continue;
    const role = item.role;
    const text = Array.isArray(item.content)
      ? item.content
          .map(asRecord)
          .filter((part) =>
            (part?.type === "input_text" || part?.type === "output_text")
            && typeof part.text === "string"
          )
          .map((part) => String(part?.text))
          .join("\n")
          .trim()
      : "";
    if (!text || contextual(text)) continue;
    if (role === "user") {
      if (user.length || assistant.length) {
        turns.push({ user, assistant });
        user = [];
        assistant = [];
      }
      user.push(text);
    } else if (role === "assistant" && (user.length || assistant.length)) {
      assistant.push(text);
    }
  }
  if (user.length || assistant.length) turns.push({ user, assistant });
  if (!turns.length) return undefined;

  let output = "Most recent user/assistant turns from this exact thread. Use them for continuity when responding.";
  let remaining = CURRENT_THREAD_BUDGET - tokens(output);
  for (const [index, turn] of turns.reverse().entries()) {
    if (remaining <= 0) break;
    let rendered = index === 0 ? "### Latest turn" : `### Previous turn ${index}`;
    if (turn.user.length) rendered += `\nUser:\n${turn.user.join("\n\n")}`;
    if (turn.assistant.length) rendered += `\n\nAssistant:\n${turn.assistant.join("\n\n")}`;
    rendered = truncate(rendered, Math.min(TURN_BUDGET, remaining));
    remaining -= tokens(rendered);
    output += `\n\n${rendered}`;
  }
  return output;
}

function contextual(text: string): boolean {
  return text.startsWith("# AGENTS.md instructions")
    || [
      "<environment_context>",
      "<permissions instructions>",
      "<realtime_conversation>",
      "<turn_aborted>",
    ].some((marker) => text.startsWith(marker));
}

async function workspaceMap(path: string, workspace: Workspace): Promise<string | undefined> {
  const tree: string[] = [];
  await appendTree(tree, workspace, ".", 0);
  const lines = [
    `Current working directory: ${path}`,
    `Working directory name: ${pathName(path)}`,
  ];
  if (tree.length) lines.push("", "Working directory tree:", ...tree);
  return lines.join("\n");
}

async function appendTree(
  output: string[],
  workspace: Workspace,
  path: string,
  depth: number,
): Promise<void> {
  if (depth >= TREE_DEPTH) return;
  const entries = (await workspace.list(path, { maxEntries: WORKSPACE_LIST_LIMIT }))
    .filter((entry) => !noisy(entry))
    .sort((left, right) =>
      Number(left.kind === "file") - Number(right.kind === "file")
        || left.path.localeCompare(right.path)
    );
  for (const entry of entries.slice(0, TREE_ENTRIES)) {
    output.push(`${"  ".repeat(depth)}- ${pathName(entry.path)}${entry.kind === "directory" ? "/" : ""}`);
    if (entry.kind === "directory") await appendTree(output, workspace, entry.path, depth + 1);
  }
  if (entries.length > TREE_ENTRIES) {
    output.push(`${"  ".repeat(depth)}- ... ${entries.length - TREE_ENTRIES} more entries`);
  }
}

function noisy(entry: WorkspaceEntry): boolean {
  const name = pathName(entry.path);
  return name.startsWith(".") || NOISY_DIRECTORIES.has(name);
}

function pathName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function section(parts: string[], title: string, body: string | undefined, budget: number): void {
  if (!body?.trim()) return;
  const heading = `## ${title}\n`;
  const truncated = truncate(body, Math.max(0, budget - tokens(heading)));
  if (truncated) parts.push(`${heading}${truncated}`);
}

function tokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / APPROX_BYTES_PER_TOKEN);
}

function truncate(text: string, budget: number): string {
  const maximum = budget * APPROX_BYTES_PER_TOKEN;
  if (new TextEncoder().encode(text).byteLength <= maximum) return text;
  const marker = "\n…truncated…\n";
  const keep = Math.max(0, maximum - new TextEncoder().encode(marker).byteLength);
  const head = takeFirstBytes(text, Math.floor(keep / 2));
  const tail = takeLastBytes(text, keep - utf8Bytes(head));
  return `${head}${marker}${tail}`;
}

function takeFirstBytes(text: string, maximum: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const next = utf8Bytes(character);
    if (bytes + next > maximum) break;
    bytes += next;
    end += character.length;
  }
  return text.slice(0, end);
}

function takeLastBytes(text: string, maximum: number): string {
  let bytes = 0;
  let start = text.length;
  const characters = [...text];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const next = utf8Bytes(character);
    if (bytes + next > maximum) break;
    bytes += next;
    start -= character.length;
  }
  return text.slice(start);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
