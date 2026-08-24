import { describe, expect, it, vi } from "vitest";
import { justBash } from "nanocodex/tools/bash";
import type { Workspace } from "nanocodex/workspace";

import {
  createManagedGhCommand,
  createManagedShellFetch,
  type ManagedShellFetch,
} from "../src/computer-shell";

const SUBJECT = "s".repeat(43);

describe("Nanocodex managed Just Bash commands", () => {
  it("routes Drive curl through the managed connector boundary", async () => {
    const seen: Request[] = [];
    const shell = await justBash({
      filesystem: memoryWorkspace(),
      fetch: createManagedShellFetch({
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init);
          seen.push(request);
          return Response.json({ files: [{ id: "drive-file" }] });
        },
      } as Fetcher, SUBJECT),
    });

    const result = await shell.tool.handler({
      cmd: "curl -s 'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)'",
    }, {
      callId: "drive-curl",
      parentCallId: "",
      sessionId: "test",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      exit_code: 0,
      output: JSON.stringify({ files: [{ id: "drive-file" }] }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)",
    );
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer NANOCODEX_PROVIDER_CREDENTIAL");
    expect(seen[0]!.headers.get("x-nanocodex-subject")).toBe(SUBJECT);
  });

  it("routes connector calls through the private broker without exposing its credential", async () => {
    const seen: Request[] = [];
    const fetch = createManagedShellFetch({
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = new Request(input, init);
        seen.push(request);
        return Response.json({ full_name: "gakonst/nanocodex" });
      },
    } as Fetcher, SUBJECT);

    const result = await fetch("https://api.github.com/repos/gakonst/nanocodex");
    expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
      full_name: "gakonst/nanocodex",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer NANOCODEX_PROVIDER_CREDENTIAL");
    expect(seen[0]!.headers.get("x-nanocodex-subject")).toBe(SUBJECT);
  });

  it("fails connector calls closed when a shared-room shell has no subject", async () => {
    const binding = { fetch: vi.fn() } as unknown as Fetcher;
    const fetch = createManagedShellFetch(binding);

    for (const url of [
      "https://api.github.com/user",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      "https://www.googleapis.com/drive/v3/files",
    ]) {
      const response = await fetch(url);
      expect(response.status).toBe(403);
      expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ error: "requires_login" });
    }
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it("implements the useful read/write gh compatibility surface", async () => {
    const fetch = vi.fn(async (url: string) => response(url.endsWith("/user")
      ? { login: "gakonst" }
      : { full_name: "gakonst/nanocodex", description: "small agents", html_url: "https://github.com/gakonst/nanocodex" })) as ManagedShellFetch;
    const gh = createManagedGhCommand(fetch);

    expect(await gh.execute(["auth", "status"])).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("gakonst"),
    });
    expect(await gh.execute(["api", "repos/gakonst/nanocodex"])).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("gakonst/nanocodex"),
    });
    expect(await gh.execute(["repo", "view", "gakonst/nanocodex"])).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("small agents"),
    });
    expect(await gh.execute([
      "api", "--method", "POST", "repos/gakonst/nanocodex/issues", "-f", "title=hello",
    ])).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("gakonst/nanocodex"),
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/gakonst/nanocodex/issues",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "hello" }) }),
    );
  });
});

function response(value: unknown) {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(value)),
    url: "https://api.github.com/mock",
  };
}

function memoryWorkspace(): Workspace {
  const files = new Map<string, Uint8Array>();
  return {
    root: "/workspace",
    async list() {
      return [...files].map(([path, contents]) => ({
        kind: "file" as const,
        path,
        size: contents.byteLength,
      }));
    },
    async readFile(path) {
      const contents = files.get(path);
      if (!contents) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return contents;
    },
    async writeFile(path, contents) {
      files.set(path, toBytes(contents));
    },
    async remove(path) {
      files.delete(path);
    },
    async mkdir() {},
  };
}

function toBytes(value: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}
