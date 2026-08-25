import { createWorkspace, type Workspace } from "nanocodex/workspace";

import {
  sanitizeDialogue,
  type WorldBoardMessage,
} from "./monsterWorldProtocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const ROOM_README = `# World room

messages.jsonl is the reducer-owned, append-only room transcript shared by every resident.
Use tail, grep, sed, or awk to inspect it. Messages are ordered oldest to newest.

To post, write one short message to send:

  printf '%s' 'I will cover the north path.' > /workspace/world/room/send

messages.jsonl and this README are read-only. The send file is an authenticated reducer action,
not ordinary shared storage.
`;

const ROOM_FILES = Object.freeze([
  { kind: "directory", path: "world" },
  { kind: "directory", path: "world/room" },
  { kind: "file", path: "world/room/README.md" },
  { kind: "file", path: "world/room/messages.jsonl" },
  { kind: "file", path: "world/room/send" },
] as const);

export type WorldRoomWorkspaceOptions = Readonly<{
  messages(): readonly WorldBoardMessage[];
  send(text: string): Promise<void>;
}>;

export function createWorldRoomWorkspace(options: WorldRoomWorkspaceOptions): Workspace {
  return createWorkspace({
    root: "/workspace",
    backend: {
      async list(path, { recursive, maxEntries }) {
        const prefix = path ? `${path}/` : "";
        const entries = ROOM_FILES
          .filter((entry) => entry.path.startsWith(prefix))
          .filter((entry) => recursive || !entry.path.slice(prefix.length).includes("/"))
          .map((entry) => {
            const size = entry.kind === "directory"
              ? undefined
              : entry.path.endsWith("README.md")
                ? encoder.encode(ROOM_README).byteLength
                : entry.path.endsWith("messages.jsonl")
                  ? encoder.encode(formatWorldRoomMessages(options.messages())).byteLength
                  : 0;
            return Object.freeze({
              kind: entry.kind,
              path: entry.path,
              ...(size === undefined ? {} : { size }),
            });
          });
        if (entries.length > maxEntries) throw new RangeError("World room listing exceeds its bound");
        return entries;
      },
      async readFile(path) {
        if (path === "world/room/README.md") return encoder.encode(ROOM_README);
        if (path === "world/room/messages.jsonl") {
          return encoder.encode(formatWorldRoomMessages(options.messages()));
        }
        if (path === "world/room/send") return new Uint8Array();
        throw new Error(`World room file does not exist: ${path}`);
      },
      async writeFile(path, contents) {
        if (path !== "world/room/send") {
          throw new Error(`${path || "the workspace root"} is read-only`);
        }
        if (contents.byteLength > 1_024) throw new Error("A room message must be at most 1024 bytes");
        // Shell redirection truncates before writing the command's bytes. The
        // empty truncate is not a room post; the following write is.
        if (contents.byteLength === 0) return;
        const text = sanitizeDialogue(decoder.decode(contents));
        if (!text) throw new Error("A room message must contain visible text");
        await options.send(text);
      },
      async remove() {
        throw new Error("World room files cannot be removed");
      },
      async mkdir(path) {
        if (path === "" || path === "world" || path === "world/room") return;
        throw new Error(`World room directory does not exist: ${path}`);
      },
    },
  });
}

export function formatWorldRoomMessages(messages: readonly WorldBoardMessage[]): string {
  if (messages.length === 0) return "";
  return `${[...messages]
    .sort((left, right) => left.id - right.id)
    .map((message) => JSON.stringify({
      seq: message.id,
      from: message.fromName,
      from_id: message.fromId,
      ...(message.toName === undefined ? {} : { to: message.toName, to_id: message.toId }),
      text: message.text,
      minute_of_day: message.minuteOfDay,
      origin: message.origin,
    }))
    .join("\n")}\n`;
}
