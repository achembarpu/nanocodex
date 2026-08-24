import { handleManagedEgress } from "./managed-egress";

type ShellFetchOptions = Readonly<{
  method?: string | undefined;
  headers?: Headers | Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
}>;

type ShellFetchResult = Readonly<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
  url: string;
}>;

export type ManagedShellFetch = (
  url: string,
  options?: ShellFetchOptions,
) => Promise<ShellFetchResult>;

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** One credential-free fetch capability shared by curl and app-owned shell commands. */
export function createManagedShellFetch(binding: Fetcher, subject?: string): ManagedShellFetch {
  return async (url, options = {}) => {
    const method = (options.method ?? "GET").toUpperCase();
    const request = new Request(url, {
      method,
      headers: options.headers,
      ...(method === "GET" || method === "HEAD" || options.body === undefined
        ? {}
        : { body: options.body }),
      signal: options.signal,
    });
    const response = await handleManagedEgress(request, binding, subject);
    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    response.headers.forEach((value, name) => { headers[name] = value; });
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body: new Uint8Array(await response.arrayBuffer()),
      url: response.url || request.url,
    };
  };
}

/** gh compatibility command backed by the connected GitHub account. */
export function createManagedGhCommand(fetch: ManagedShellFetch) {
  return {
    name: "gh",
    trusted: true,
    async execute(args: string[]) {
      try {
        if (args[0] === "auth" && args[1] === "status") {
          const user = await github(fetch, "/user");
          return ok(`Logged in to github.com as ${text(user, "login")} through the connected account.\n`);
        }
        if (args[0] === "api") {
          const method = (option(args, "--method", "-X") ?? "GET").toUpperCase();
          const endpoint = args.find((value, index) => !value.startsWith("-")
            && index > 0 && args[index - 1] !== "--method" && args[index - 1] !== "-X");
          if (!endpoint) throw new Error("gh api requires an endpoint");
          const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
          const fields = apiFields(args);
          return ok(`${JSON.stringify(await github(fetch, path, {
            method,
            ...(Object.keys(fields).length ? { body: JSON.stringify(fields) } : {}),
          }), null, 2)}\n`);
        }
        if (args[0] === "repo" && args[1] === "view") {
          const repository = option(args.slice(2), "--repo", "-R")
            ?? args.slice(2).find((value) => !value.startsWith("-"));
          requireRepository(repository, "gh repo view requires OWNER/REPO");
          const repo = requireRecord(
            await github(fetch, `/repos/${repository}`),
            "repository",
          );
          return ok([
            `name:\t${optionalText(repo, "full_name") ?? repository}`,
            `description:\t${optionalText(repo, "description") ?? ""}`,
            `url:\t${optionalText(repo, "html_url") ?? `https://github.com/${repository}`}`,
            "",
          ].join("\n"));
        }
        if (args[0] === "pr" && args[1] === "list") {
          const repository = option(args.slice(2), "--repo", "-R");
          requireRepository(repository, "gh pr list requires --repo OWNER/REPO");
          const pulls = await github(fetch, `/repos/${repository}/pulls?${new URLSearchParams({
            state: "open",
            per_page: String(limit(option(args.slice(2), "--limit", "-L"))),
          })}`);
          if (!Array.isArray(pulls)) throw new Error("GitHub returned an invalid pull request list");
          return ok(pulls.map((pull) => {
            const row = requireRecord(pull, "pull request");
            const head = requireRecord(row.head, "pull request head");
            return [row.number, text(row, "title"), text(head, "ref")].join("\t");
          }).join("\n") + (pulls.length ? "\n" : ""));
        }
        return ok([
          "gh (Nanocodex Just Bash compatibility command)",
          "",
          "Supported commands:",
          "  gh auth status",
          "  gh api [--method METHOD] [-f key=value] ENDPOINT",
          "  gh repo view OWNER/REPO",
          "  gh pr list --repo OWNER/REPO [--limit N]",
          "",
          "Connected GitHub calls use the permissions granted in Profile.",
          "",
        ].join("\n"));
      } catch (error) {
        return fail(`gh: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    },
  };
}

async function github(
  fetch: ManagedShellFetch,
  path: string,
  options: Readonly<{ method?: string; body?: string }> = {},
): Promise<unknown> {
  const url = new URL(path, "https://api.github.com");
  if (url.origin !== "https://api.github.com") throw new Error("endpoint is outside api.github.com");
  const response = await fetch(url.href, {
    method: options.method,
    headers: {
      accept: "application/vnd.github+json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body,
  });
  const raw = new TextDecoder().decode(response.body);
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : null; } catch {
    throw new Error(`GitHub returned invalid JSON (HTTP ${response.status})`);
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = value && typeof value === "object"
      ? optionalText(value as Record<string, unknown>, "message")
        ?? optionalText(value as Record<string, unknown>, "error")
      : undefined;
    throw new Error(`GitHub request failed (HTTP ${response.status}${detail ? `: ${detail}` : ""})`);
  }
  return value;
}

function apiFields(args: string[]): Record<string, string> {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 0; index < args.length; index += 1) {
    if (!["-f", "-F", "--field", "--raw-field"].includes(args[index]!)) continue;
    const field = args[index + 1];
    const separator = field?.indexOf("=") ?? -1;
    if (!field || separator <= 0) throw new Error(`${args[index]} requires key=value`);
    fields[field.slice(0, separator)] = field.slice(separator + 1);
    index += 1;
  }
  return fields;
}

function option(args: string[], long: string, short: string): string | undefined {
  const index = args.findIndex((value) => value === long || value === short);
  return index === -1 ? undefined : args[index + 1];
}

function limit(value: string | undefined): number {
  if (value === undefined) return 30;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  return parsed;
}

function requireRepository(value: string | undefined, message: string): asserts value is string {
  if (!value || !REPOSITORY.test(value)) throw new Error(message);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub returned an invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, key: string): string {
  const field = requireRecord(value, "response")[key];
  if (typeof field !== "string") throw new Error(`GitHub response is missing ${key}`);
  return field;
}

function optionalText(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function ok(stdout: string) { return { stdout, stderr: "", exitCode: 0 }; }
function fail(stderr: string) { return { stdout: "", stderr, exitCode: 1 }; }
