import git from "isomorphic-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { justBash } from "nanocodex/tools/bash";
import type { Workspace } from "nanocodex/workspace";

import {
  createManagedGitCommand,
  createManagedGhCommand,
  createManagedShellFetch,
  type ManagedShellFetch,
} from "../src/computer-shell";

const SUBJECT = "s".repeat(43);

afterEach(() => vi.restoreAllMocks());

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
      model: "gpt-5.6-sol",
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

  it("enforces the active turn connector projection at actual provider egress", async () => {
    const binding = { fetch: vi.fn(async () => Response.json({ ok: true })) } as unknown as Fetcher;
    const fetch = createManagedShellFetch(
      binding,
      SUBJECT,
      (connector) => connector === "github",
    );

    expect((await fetch("https://api.github.com/user")).status).toBe(200);
    const denied = await fetch("https://www.googleapis.com/drive/v3/files");
    expect(denied.status).toBe(403);
    expect(JSON.parse(new TextDecoder().decode(denied.body))).toEqual({
      error: "connector_forbidden",
    });
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it("implements the useful read/write gh compatibility surface", async () => {
    const fetch = vi.fn(async (url: string) => response(url.endsWith("/user")
      ? { login: "gakonst" }
      : url.includes("/user/repos?")
        ? [{
          full_name: "gakonst/nanocodex",
          description: "small agents",
          private: true,
          owner: { login: "gakonst" },
        }]
        : { full_name: "gakonst/nanocodex", description: "small agents", html_url: "https://github.com/gakonst/nanocodex" })) as ManagedShellFetch;
    const clone = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "Cloning into 'centaur'...\n",
    }));
    const gh = createManagedGhCommand(fetch, clone);

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
    expect(await gh.execute(["repo", "list", "gakonst", "--limit", "20"])).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("gakonst/nanocodex\tsmall agents\tprivate"),
    });
    expect(await gh.execute([
      "api",
      "-f", "title=hello",
      "-F", "count=2",
      "--field", "kind=bug",
      "--raw-field", "body=details",
      "repos/gakonst/nanocodex/issues",
    ])).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("gakonst/nanocodex"),
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/gakonst/nanocodex/issues",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "hello", count: "2", kind: "bug", body: "details" }),
      }),
    );
    await gh.execute(["api", "-f", "page=1", "-X", "GET", "user"]);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.github.com/user?page=1",
      expect.objectContaining({ method: "GET", body: undefined }),
    );
    expect(await gh.execute([
      "repo", "clone", "paradigmxyz/centaur", "centaur-src",
      "--", "--depth", "1", "--branch", "main",
    ], { cwd: "/workspace/repositories" })).toMatchObject({
      exitCode: 0,
      stdout: "Cloning into 'centaur'...\n",
    });
    expect(clone).toHaveBeenCalledWith([
      "--depth", "1", "--branch", "main",
      "https://github.com/paradigmxyz/centaur.git",
      "centaur-src",
    ], { cwd: "/workspace/repositories" });
  });

  it("advertises managed git clone and rejects non-GitHub repositories", async () => {
    const git = createManagedGitCommand(vi.fn() as ManagedShellFetch, memoryWorkspace);

    expect(await git.execute(["status"])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("not a git repository"),
    });
    expect(await git.execute(["clone", "https://example.com/repository.git"])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("https://github.com/OWNER/REPO"),
    });
  });

  it("renders managed git short status from the isomorphic-git matrix", async () => {
    vi.spyOn(git, "statusMatrix").mockResolvedValue([
      ["added-deleted.txt", 0, 0, 3],
      ["added-modified.txt", 0, 2, 3],
      ["added.txt", 0, 2, 2],
      ["deleted-recreated.txt", 1, 2, 0],
      ["deleted-staged.txt", 1, 0, 0],
      ["deleted.txt", 1, 0, 1],
      ["modified-deleted.txt", 1, 0, 3],
      ["modified-staged.txt", 1, 2, 2],
      ["modified.txt", 1, 2, 1],
      ["untracked.txt", 0, 2, 0],
    ]);
    const command = createManagedGitCommand(
      vi.fn() as ManagedShellFetch,
      () => memoryWorkspace({ "/workspace/.git": "" }),
    );

    expect(await command.execute(["status", "--short"])).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: [
        "AD added-deleted.txt",
        "AM added-modified.txt",
        "A  added.txt",
        "D  deleted-recreated.txt",
        "?? deleted-recreated.txt",
        "D  deleted-staged.txt",
        " D deleted.txt",
        "MD modified-deleted.txt",
        "M  modified-staged.txt",
        " M modified.txt",
        "?? untracked.txt",
        "",
      ].join("\n"),
    });
  });

  it("does not advertise a push URL for managed read-only remotes", async () => {
    vi.spyOn(git, "listRemotes").mockResolvedValue([{
      remote: "origin",
      url: "https://github.com/gakonst/nanocodex.git",
    }]);
    const command = createManagedGitCommand(
      vi.fn() as ManagedShellFetch,
      () => memoryWorkspace({ "/workspace/.git": "" }),
    );

    expect(await command.execute(["remote", "-v"])).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "origin\thttps://github.com/gakonst/nanocodex.git (fetch)\n",
    });
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

function memoryWorkspace(initialFiles: Readonly<Record<string, string>> = {}): Workspace {
  const files = new Map(Object.entries(initialFiles)
    .map(([path, contents]) => [path, new TextEncoder().encode(contents)]));
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
