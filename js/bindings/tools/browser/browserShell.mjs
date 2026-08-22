import "./browserBuffer.mjs";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { artifact } from "../artifact.mjs";
import { browserThread, notifyThreadGitChanged, prepareThreadGit, THREAD_GIT_AUTHOR, THREAD_GIT_DIRECTORY, withThreadGitLock, } from "./threadGit.mjs";
import { openThreadWorkspace } from "./workspace.mjs";
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();
const diffDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTION_MS = 30_000;
const MAX_GIT_LOG_DEPTH = 200;
const MAX_DIFF_FILE_BYTES = 1024 * 1024;
const MAX_INDEXED_PATHS = 100_000;
const MAX_PROJECT_INSTRUCTIONS_BYTES = 32 * 1024;
const PROJECT_INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md"];
const DIFF_TRUNCATION_NOTICE = "\n[diff truncated by browser git]\n";
const UNIFIED_EXEC_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        chunk_id: { type: "string", description: "Chunk identifier included when the response reports one." },
        wall_time_seconds: { type: "number", description: "Elapsed wall time spent waiting for output in seconds." },
        exit_code: { type: "number", description: "Process exit code when the command finished during this call." },
        session_id: { type: "number", description: "Session identifier to pass to write_stdin when the process is still running." },
        original_token_count: { type: "number", description: "Approximate token count before output truncation." },
        output: { type: "string", description: "Command output text, possibly truncated." },
    },
    required: ["wall_time_seconds", "output"],
    additionalProperties: false,
};
const AGENT_INSTRUCTIONS = `You are working in a persistent browser filesystem rooted at /workspace.
Use exec_command for bash commands such as ls, cat, find, grep, git, curl, wget, and python3. The
shell and Python runtime execute entirely in browser sandboxes, so they have no host process or PTY.
curl and wget use browser Fetch directly, so remote servers must permit this origin with CORS. The
clang, clang++, gcc, g++, cc, and c++ compile C/C++ sources to WASI WebAssembly in a lazy worker.
Browser SSH is noninteractive and requires a wss:// endpoint that carries raw SSH because browsers
cannot open TCP sockets. The repository's only publish branch is nanocodex;
publish with git add, git commit -m "...", and git push origin nanocodex. Use the standard Rust
apply_patch tool for focused edits. Create or update custom React interfaces with the
render_artifact tool. Its source defines function App({ sendPrompt }); React and the html tagged
template helper are already in scope.`;

export function validateBrowserArtifactSource(source) {
    try {
        // Compile with the exact bindings and strict wrapper used by the
        // isolated artifact frame without running application code.
        new Function("React", "html", "sendPrompt", `"use strict";\n${source}\n;return typeof App === "function" ? App : undefined;`);
    }
    catch (error) {
        throw new Error(`artifact source is not executable JavaScript: ${errorMessage(error)}`);
    }
}
export async function prepareBrowserShell(threadId, origin) {
    const thread = browserThread(threadId, origin);
    const [{ rawFs, workspaceRoot }, workspace] = await Promise.all([
        prepareThreadGit(thread),
        openThreadWorkspace(threadId),
    ]);
    const projectInstructions = await loadBrowserProjectInstructions(rawFs);
    let shellFs;
    let shellDirty = false;
    let shellRequest;
    const loadShell = () => {
        if (shellRequest)
            return shellRequest;
        // The shell's first path scan observes every mutation completed before
        // creation. Only mutations racing that scan require a second refresh.
        shellDirty = false;
        const loading = createBrowserBash(rawFs, thread, { workspaceRoot }).then(async (shell) => {
            shellFs = shell.filesystem;
            if (shellDirty) {
                shellDirty = false;
                await shellFs.refreshPaths();
            }
            return shell;
        }).catch((error) => {
            if (shellRequest === loading) {
                shellRequest = undefined;
                shellFs = undefined;
                shellDirty = true;
            }
            throw error;
        });
        shellRequest = loading;
        return loading;
    };
    const recordShellMutation = (operation, path) => {
        if (!shellFs) {
            shellDirty = true;
            return;
        }
        shellFs[operation](path);
    };
    const notifyingWorkspace = Object.freeze({
        root: workspace.root,
        list: workspace.list,
        readFile: workspace.readFile,
        async writeFile(path, contents) {
            await workspace.writeFile(path, contents);
            try {
                recordShellMutation("recordExternalWrite", path);
            }
            finally {
                notifyThreadGitChanged(thread);
            }
        },
        async remove(path, options) {
            await workspace.remove(path, options);
            try {
                recordShellMutation("recordExternalRemove", path);
            }
            finally {
                notifyThreadGitChanged(thread);
            }
        },
        async mkdir(path) {
            await workspace.mkdir(path);
            try {
                recordShellMutation("recordExternalWrite", path);
            }
            finally {
                notifyThreadGitChanged(thread);
            }
        },
    });
    return {
        instructions: AGENT_INSTRUCTIONS,
        projectInstructions,
        workspace: notifyingWorkspace,
        artifactTool: artifact({
            workspace: notifyingWorkspace,
            validateSource: validateBrowserArtifactSource,
        }),
        execTool: {
            supportsParallelToolCalls: true,
            description: "Run a bash command in the browser thread workspace.",
            parameters: {
                type: "object",
                properties: { cmd: { type: "string" }, workdir: { type: "string" } },
                required: ["cmd"],
                additionalProperties: true,
            },
            outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
            async handler(input, context) {
                return (await loadShell()).exec(input, context);
            },
        },
    };
}
/** Captures the root project instructions using the native Nanocodex precedence and budget. */
export async function loadBrowserProjectInstructions(rawFs) {
    for (const filename of PROJECT_INSTRUCTION_FILES) {
        const path = `${THREAD_GIT_DIRECTORY}/${filename}`;
        let stat;
        try {
            stat = await rawFs.promises.stat(path);
        }
        catch (error) {
            if (error?.code === "ENOENT")
                continue;
            console.warn("failed to read project AGENTS.md instructions", { path, error });
            return undefined;
        }
        if (!stat.isFile())
            continue;
        if (stat.size > MAX_PROJECT_INSTRUCTIONS_BYTES) {
            console.warn("project doc exceeds remaining budget; truncating", {
                path,
                remainingBytes: MAX_PROJECT_INSTRUCTIONS_BYTES,
            });
        }
        try {
            const bytes = await rawFs.promises.readFile(path, {
                maxBytes: MAX_PROJECT_INSTRUCTIONS_BYTES,
            });
            const instructions = utf8Decoder.decode(bytes);
            return instructions.trim() ? instructions : undefined;
        }
        catch (error) {
            console.warn("failed to read project AGENTS.md instructions", { path, error });
            return undefined;
        }
    }
    return undefined;
}
/** Builds the browser shell over an already-open OPFS Git adapter. */
export async function createBrowserBash(rawFs, thread, options = {}) {
    const [{ Bash, defineCommand }, { createTwoFilesPatch }] = await Promise.all([
        import("just-bash/browser"),
        import("diff"),
    ]);
    const filesystem = new OpfsShellFileSystem(rawFs);
    await filesystem.refreshPaths();
    const executionTimeoutMs = options.executionTimeoutMs ?? MAX_EXECUTION_MS;
    let pythonRuntime = options.pythonRuntime;
    const loadPython = async (name) => {
        const module = await import("./browserPython.mjs");
        pythonRuntime ??= options.workspaceRoot
            ? new module.BrowserPythonRuntime(options.workspaceRoot)
            : undefined;
        return module.createPythonCommand(name, pythonRuntime, filesystem);
    };
    const bash = new Bash({
        cwd: THREAD_GIT_DIRECTORY,
        env: {
            HOME: THREAD_GIT_DIRECTORY,
            PWD: THREAD_GIT_DIRECTORY,
            GIT_AUTHOR_NAME: THREAD_GIT_AUTHOR.name,
            GIT_AUTHOR_EMAIL: THREAD_GIT_AUTHOR.email,
            GIT_COMMITTER_NAME: THREAD_GIT_AUTHOR.name,
            GIT_COMMITTER_EMAIL: THREAD_GIT_AUTHOR.email,
            PATH: THREAD_GIT_DIRECTORY,
        },
        fs: filesystem,
        fetch: options.fetch ?? browserSecureFetch,
        customCommands: [
            gitCommand(rawFs, thread, filesystem, defineCommand, createTwoFilesPatch),
            ghCommand(rawFs, thread, defineCommand),
            unameCommand(defineCommand),
            ...["python3", "python"].map((name) => ({
                name,
                load: () => loadPython(name),
            })),
            {
                name: "ssh",
                load: async () => (await import("./browserSsh.mjs")).createSshCommand(filesystem),
            },
            ...["clang", "clang++", "gcc", "g++", "cc", "c++"].map((name) => ({
                name,
                load: async () => (await import("./browserCompiler.mjs")).createCompilerCommand(name, filesystem),
            })),
        ],
        executionLimitProfile: "hardened",
        executionLimits: {
            maxCommandCount: 10_000,
            maxExecutionTimeMs: executionTimeoutMs,
            maxFileSystemBytes: 256 * 1024 * 1024,
            maxInputBytes: 16 * 1024 * 1024,
            maxLiveBytes: 64 * 1024 * 1024,
            maxOutputSize: MAX_OUTPUT_BYTES,
            maxSourceBytes: 1024 * 1024,
            maxStringLength: 16 * 1024 * 1024,
            maxTraversalEntries: 100_000,
        },
    });
    return {
        bash,
        filesystem,
        exec: (input, context) => execute(bash, filesystem, thread, input, options.onChanged ?? (() => notifyThreadGitChanged(thread)), context?.signal, executionTimeoutMs),
    };
}
const browserSecureFetch = async (target, options = {}) => {
    const url = new URL(target, globalThis.location?.href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("browser curl supports only credential-free http:// and https:// URLs");
    }
    const timeout = new AbortController();
    const timeoutMs = Math.min(options.timeoutMs ?? MAX_EXECUTION_MS, MAX_EXECUTION_MS);
    const timeoutId = setTimeout(() => timeout.abort(new Error("network request timed out")), timeoutMs);
    const abort = () => timeout.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted)
        abort();
    try {
        const response = await fetch(url, {
            method: options.method,
            headers: options.headers,
            body: options.body,
            credentials: "omit",
            redirect: options.followRedirects === false ? "manual" : "follow",
            signal: timeout.signal,
        });
        return {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: new Uint8Array(await response.arrayBuffer()),
            url: response.url || url.href,
        };
    }
    catch (error) {
        if (timeout.signal.aborted)
            throw timeout.signal.reason;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`browser fetch failed (${detail}); the target must allow this origin with CORS`);
    }
    finally {
        clearTimeout(timeoutId);
        options.signal?.removeEventListener("abort", abort);
    }
};
function unameCommand(defineCommand) {
    return defineCommand("uname", async (args) => {
        const fields = {
            s: "Nanocodex",
            n: "browser",
            r: "1.0.0",
            v: "browser-wasm",
            m: "wasm32",
            p: "wasm32",
            i: "wasm32",
            o: "Browser",
        };
        if (args.includes("--help")) {
            return ok("usage: uname [-asnrvmpio]\n");
        }
        const requested = [];
        for (const arg of args.length ? args : ["-s"]) {
            if (arg === "--all")
                requested.push("s", "n", "r", "v", "m", "p", "i", "o");
            else if (/^-[asnrvmpio]+$/.test(arg)) {
                for (const flag of arg.slice(1)) {
                    if (flag === "a")
                        requested.push("s", "n", "r", "v", "m", "p", "i", "o");
                    else
                        requested.push(flag);
                }
            }
            else {
                return fail(`uname: unrecognized option '${arg}'\n`, 1);
            }
        }
        return ok(`${[...new Set(requested)].map((key) => fields[key]).join(" ")}\n`);
    });
}
async function execute(bash, shellFs, thread, input, onChanged, signal, executionTimeoutMs = MAX_EXECUTION_MS) {
    if (typeof input?.cmd !== "string" || !input.cmd.trim()) {
        throw new TypeError("exec_command.cmd must be a non-empty string");
    }
    if (input.tty === true)
        throw new Error("browser bash does not provide PTY sessions");
    if (input.sandbox_permissions === "require_escalated") {
        throw new Error("browser bash cannot escape its OPFS workspace sandbox");
    }
    if (input.shell !== undefined && input.shell !== "bash" && input.shell !== "/bin/bash") {
        throw new Error("browser exec_command supports only its embedded bash interpreter");
    }
    const workdir = input.workdir === undefined ? THREAD_GIT_DIRECTORY : requireString(input.workdir, "workdir");
    const maxTokens = optionalPositiveInteger(input.max_output_tokens, 10_000);
    const startedAt = performance.now();
    const deadline = new AbortController();
    const abort = () => deadline.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted)
        abort();
    const timeout = setTimeout(() => deadline.abort(new Error(`browser exec_command exceeded ${executionTimeoutMs} milliseconds`)), executionTimeoutMs);
    let result;
    try {
        result = await withThreadGitLock(thread, async () => {
            const mutationVersion = shellFs.mutationVersion;
            try {
                return await bash.exec(input.cmd, { cwd: workdir, signal: deadline.signal });
            }
            finally {
                if (shellFs.mutationVersion !== mutationVersion)
                    onChanged();
            }
        }, deadline.signal);
    }
    finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
    const combined = `${result.stdout}${result.stderr}`;
    const maxCharacters = maxTokens * 4;
    const truncated = combined.length > maxCharacters;
    return {
        output: truncated
            ? `${combined.slice(0, maxCharacters)}\n[output truncated by browser exec_command]`
            : combined,
        wall_time_seconds: (performance.now() - startedAt) / 1000,
        exit_code: result.exitCode,
        ...(truncated ? { original_token_count: Math.ceil(combined.length / 4) } : {}),
    };
}
function gitCommand(fs, thread, shellFs, defineCommand, createTwoFilesPatch) {
    return defineCommand("git", async (args, context) => {
        try {
            const command = args[0];
            switch (command) {
                case undefined:
                case "help":
                case "--help":
                    return ok(gitHelp());
                case "status":
                    return ok(await gitStatus(fs, thread, args.slice(1)));
                case "add": {
                    const output = await gitAdd(fs, args.slice(1), context.cwd, () => shellFs.recordRepositoryMutation());
                    return ok(output);
                }
                case "commit": {
                    const output = await gitCommit(fs, args.slice(1));
                    shellFs.recordRepositoryMutation();
                    return ok(output);
                }
                case "push":
                    return ok(await gitPush(fs, thread, args.slice(1)));
                case "pull": {
                    const output = await gitPull(fs, thread, args.slice(1));
                    await shellFs.refreshPaths();
                    shellFs.recordRepositoryMutation();
                    return ok(output);
                }
                case "log":
                    return ok(await gitLog(fs, args.slice(1)));
                case "diff":
                    return ok(await gitDiff(fs, args.slice(1), createTwoFilesPatch));
                case "branch":
                    return ok(gitBranch(thread, args.slice(1)));
                case "rev-parse":
                    return ok(await gitRevParse(fs, thread, args.slice(1)));
                case "remote":
                    return ok(gitRemote(thread, args.slice(1)));
                case "ls-files":
                    return ok(`${(await git.listFiles({ fs, dir: THREAD_GIT_DIRECTORY })).join("\n")}\n`);
                default:
                    return fail(`git: '${command}' is not implemented by browser git\n${gitHelp()}`, 1);
            }
        }
        catch (error) {
            return fail(`git: ${errorMessage(error)}\n`, 1);
        }
    });
}
function ghCommand(fs, thread, defineCommand) {
    return defineCommand("gh", async (args) => {
        try {
            if (args[0] === "repo" && args[1] === "view") {
                const head = await resolveHead(fs);
                return ok([
                    `name:\t${thread.repositoryName}`,
                    `branch:\t${thread.branch}`,
                    `head:\t${head ?? "unborn"}`,
                    `remote:\t${thread.remoteUrl}`,
                    `share:\t${thread.shareUrl}`,
                    "",
                ].join("\n"));
            }
            if (args[0] === "auth" && args[1] === "status") {
                return ok("Cloudflare thread Git uses the current web session; no GitHub token is required.\n");
            }
            if (args[0] === "pr") {
                return fail("gh: pull requests are not available for Cloudflare thread repositories\n", 1);
            }
            return ok([
                "gh (Nanocodex browser compatibility command)",
                "",
                "Supported commands:",
                "  gh repo view",
                "  gh auth status",
                "",
                "This workspace is backed by Cloudflare Git, not github.com.",
                "",
            ].join("\n"));
        }
        catch (error) {
            return fail(`gh: ${errorMessage(error)}\n`, 1);
        }
    });
}
async function gitStatus(fs, thread, args) {
    const matrix = await git.statusMatrix({ fs, dir: THREAD_GIT_DIRECTORY });
    const changed = matrix.filter(([, head, workdir, stage]) => head !== workdir || head !== stage);
    if (args.includes("--short") || args.includes("-s") || args.includes("--porcelain")) {
        return changed.map(([path, head, workdir, stage]) => {
            const code = head === 0 && stage === 0 && workdir !== 0
                ? "??"
                : `${indexCode(head, stage)}${worktreeCode(stage, workdir)}`;
            return `${code} ${path}`;
        }).join("\n") + (changed.length ? "\n" : "");
    }
    const head = await resolveHead(fs);
    if (!changed.length)
        return `On branch ${thread.branch}\nnothing to commit, working tree clean\n`;
    return [
        `On branch ${thread.branch}`,
        head ? "Changes not staged or staged for commit:" : "No commits yet",
        ...changed.map(([path, headStatus, workdirStatus, stageStatus]) => `  ${describeStatus(headStatus, workdirStatus, stageStatus)}: ${path}`),
        "",
    ].join("\n");
}
async function gitAdd(fs, args, cwd, onStaged) {
    const requested = args.filter((arg) => !arg.startsWith("-"));
    if (!requested.length && !args.includes("-A") && !args.includes("--all")) {
        throw new Error("nothing specified, nothing added");
    }
    const matrix = await git.statusMatrix({ fs, dir: THREAD_GIT_DIRECTORY });
    const all = args.includes("-A") || args.includes("--all") || requested.includes(".");
    const prefixes = requested.filter((path) => path !== ".").map((path) => repositoryPath(path, cwd));
    const selected = matrix.filter(([path]) => all || prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)));
    if (!all && selected.length === 0)
        throw new Error(`pathspec '${requested.join(" ")}' did not match any files`);
    let staged = false;
    try {
        for (const [filepath, , workdirStatus] of selected) {
            if (workdirStatus === 0)
                await git.remove({ fs, dir: THREAD_GIT_DIRECTORY, filepath });
            else
                await git.add({ fs, dir: THREAD_GIT_DIRECTORY, filepath });
            staged = true;
        }
    }
    finally {
        if (staged)
            onStaged();
    }
    return "";
}
async function gitCommit(fs, args) {
    const messageIndex = args.findIndex((arg) => arg === "-m" || arg === "--message");
    const message = messageIndex >= 0 ? args[messageIndex + 1] : undefined;
    if (!message?.trim())
        throw new Error("a commit message is required (use -m)");
    const matrix = await git.statusMatrix({ fs, dir: THREAD_GIT_DIRECTORY });
    if (!matrix.some(([, head, , stage]) => head !== stage))
        throw new Error("nothing to commit");
    const oid = await git.commit({
        fs,
        dir: THREAD_GIT_DIRECTORY,
        message,
        author: THREAD_GIT_AUTHOR,
    });
    return `[nanocodex ${oid.slice(0, 7)}] ${message}\n`;
}
async function gitPush(fs, thread, args) {
    assertRemoteAndBranch(args, thread);
    const head = await resolveHead(fs);
    if (!head)
        throw new Error("the current branch has no commits");
    await git.push({
        fs,
        http,
        dir: THREAD_GIT_DIRECTORY,
        remote: "origin",
        ref: thread.branch,
        remoteRef: thread.branch,
    });
    return `To ${thread.remoteUrl}\n   ${head.slice(0, 7)}  ${thread.branch} -> ${thread.branch}\n`;
}
async function gitPull(fs, thread, args) {
    assertRemoteAndBranch(args, thread);
    await git.pull({
        fs,
        http,
        dir: THREAD_GIT_DIRECTORY,
        remote: "origin",
        ref: thread.branch,
        author: THREAD_GIT_AUTHOR,
    });
    return `Pulled origin/${thread.branch}.\n`;
}
async function gitLog(fs, args) {
    const countArgument = args.find((arg) => /^-\d+$/.test(arg));
    const depth = countArgument ? Number(countArgument.slice(1)) : 20;
    if (!Number.isSafeInteger(depth) || depth > MAX_GIT_LOG_DEPTH) {
        throw new Error(`browser git log depth cannot exceed ${MAX_GIT_LOG_DEPTH}`);
    }
    const commits = await git.log({ fs, dir: THREAD_GIT_DIRECTORY, depth }).catch(() => []);
    if (args.includes("--oneline")) {
        return commits.map(({ oid, commit }) => `${oid.slice(0, 7)} ${firstLine(commit.message)}`).join("\n") + (commits.length ? "\n" : "");
    }
    return commits.map(({ oid, commit }) => [
        `commit ${oid}`,
        `Author: ${commit.author.name} <${commit.author.email}>`,
        `Date:   ${new Date(commit.author.timestamp * 1000).toISOString()}`,
        "",
        `    ${commit.message.trim().replace(/\n/g, "\n    ")}`,
        "",
    ].join("\n")).join("\n");
}
async function gitDiff(fs, args, createTwoFilesPatch) {
    if (args.includes("--cached") || args.includes("--staged")) {
        throw new Error("--cached is not implemented by browser git yet");
    }
    const head = await resolveHead(fs);
    const matrix = await git.statusMatrix({ fs, dir: THREAD_GIT_DIRECTORY });
    const requested = args.filter((arg) => !arg.startsWith("-") && arg !== "--");
    const files = matrix.filter(([path, headStatus, workdirStatus]) => headStatus !== workdirStatus && (!requested.length || requested.includes(path)));
    const patches = [];
    let outputLength = 0;
    for (const [filepath, headStatus, workdirStatus] of files) {
        const worktreePath = `${THREAD_GIT_DIRECTORY}/${filepath}`;
        const worktreeTooLarge = workdirStatus !== 0 &&
            (await fs.promises.stat(worktreePath)).size > MAX_DIFF_FILE_BYTES;
        const beforeBytes = head && headStatus !== 0 && !worktreeTooLarge
            ? (await git.readBlob({ fs, dir: THREAD_GIT_DIRECTORY, oid: head, filepath })).blob
            : undefined;
        const afterBytes = workdirStatus !== 0 && !worktreeTooLarge
            ? await fs.promises.readFile(worktreePath)
            : undefined;
        const patch = worktreeTooLarge ||
            (beforeBytes?.byteLength ?? 0) > MAX_DIFF_FILE_BYTES ||
            (afterBytes?.byteLength ?? 0) > MAX_DIFF_FILE_BYTES ||
            beforeBytes?.includes(0) ||
            afterBytes?.includes(0)
            ? binaryFilePatch(filepath, headStatus, workdirStatus)
            : textFilePatch(filepath, headStatus, workdirStatus, beforeBytes, afterBytes, createTwoFilesPatch);
        const separatorLength = patches.length ? 1 : 0;
        const remaining = MAX_OUTPUT_BYTES - outputLength - separatorLength;
        if (patch.length > remaining) {
            if (remaining > DIFF_TRUNCATION_NOTICE.length) {
                patches.push(`${patch.slice(0, remaining - DIFF_TRUNCATION_NOTICE.length)}${DIFF_TRUNCATION_NOTICE}`);
            }
            else if (outputLength + DIFF_TRUNCATION_NOTICE.length <= MAX_OUTPUT_BYTES) {
                patches.push(DIFF_TRUNCATION_NOTICE);
            }
            break;
        }
        patches.push(patch);
        outputLength += separatorLength + patch.length;
    }
    return patches.join("\n");
}
function textFilePatch(filepath, headStatus, workdirStatus, beforeBytes, afterBytes, createTwoFilesPatch) {
    let before;
    let after;
    try {
        before = beforeBytes ? diffDecoder.decode(beforeBytes) : "";
        after = afterBytes ? diffDecoder.decode(afterBytes) : "";
    }
    catch {
        return binaryFilePatch(filepath, headStatus, workdirStatus);
    }
    return createTwoFilesPatch(headStatus === 0 ? "/dev/null" : `a/${filepath}`, workdirStatus === 0 ? "/dev/null" : `b/${filepath}`, before, after, "HEAD", "worktree");
}
function binaryFilePatch(filepath, headStatus, workdirStatus) {
    const before = headStatus === 0 ? "/dev/null" : `a/${filepath}`;
    const after = workdirStatus === 0 ? "/dev/null" : `b/${filepath}`;
    return `diff --git a/${filepath} b/${filepath}\nBinary files ${before} and ${after} differ\n`;
}
function gitBranch(thread, args) {
    if (!args.length || args.includes("--list"))
        return `* ${thread.branch}\n`;
    if (args.includes("--show-current"))
        return `${thread.branch}\n`;
    throw new Error("browser git exposes only the nanocodex branch");
}
async function gitRevParse(fs, thread, args) {
    if (args.includes("--show-toplevel"))
        return `${THREAD_GIT_DIRECTORY}\n`;
    if (args.includes("--abbrev-ref") && args.includes("HEAD"))
        return `${thread.branch}\n`;
    if (args.length === 1 && args[0] === "HEAD") {
        const head = await resolveHead(fs);
        if (!head)
            throw new Error("ambiguous argument 'HEAD': unknown revision");
        return `${head}\n`;
    }
    throw new Error("unsupported rev-parse arguments");
}
function gitRemote(thread, args) {
    if (!args.length)
        return "origin\n";
    if (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose")) {
        return `origin\t${thread.remoteUrl} (fetch)\norigin\t${thread.remoteUrl} (push)\n`;
    }
    if (args[0] === "get-url" && args[1] === "origin")
        return `${thread.remoteUrl}\n`;
    throw new Error("only the origin remote is available");
}
function assertRemoteAndBranch(args, thread) {
    const positional = args.filter((arg) => !arg.startsWith("-"));
    const remote = positional[0] ?? "origin";
    const branch = positional[1] ?? thread.branch;
    if (remote !== "origin")
        throw new Error("only the origin remote is available");
    if (branch !== thread.branch && branch !== `HEAD:${thread.branch}`) {
        throw new Error(`only branch ${thread.branch} is available`);
    }
}
async function resolveHead(fs) {
    return git.resolveRef({ fs, dir: THREAD_GIT_DIRECTORY, ref: "HEAD" }).catch(() => undefined);
}
function indexCode(head, stage) {
    if (head === stage)
        return " ";
    if (stage === 0)
        return "D";
    if (head === 0)
        return "A";
    return "M";
}
function worktreeCode(stage, workdir) {
    if (stage === workdir)
        return " ";
    if (workdir === 0)
        return "D";
    if (stage === 0)
        return "?";
    return "M";
}
function describeStatus(head, workdir, stage) {
    if (head !== stage)
        return stage === 0 ? "deleted" : head === 0 ? "new file" : "modified";
    return workdir === 0 ? "deleted" : head === 0 ? "untracked" : "modified";
}
function repositoryPath(path, cwd) {
    const absolute = resolveWorkspacePath(cwd, path);
    if (absolute === THREAD_GIT_DIRECTORY)
        return "";
    return absolute.slice(THREAD_GIT_DIRECTORY.length + 1);
}
function gitHelp() {
    return [
        "usage: git <command> [<args>]",
        "",
        "Browser Git commands: status, add, commit, diff, log, branch, rev-parse,",
        "remote, ls-files, pull, and push. The repository is /workspace and its",
        "publish branch is nanocodex (git push origin nanocodex).",
        "",
    ].join("\n");
}
function ok(stdout) {
    return { stdout, stderr: "", exitCode: 0 };
}
function fail(stderr, exitCode) {
    return { stdout: "", stderr, exitCode };
}
class OpfsShellFileSystem {
    #fs;
    #paths = new Set([THREAD_GIT_DIRECTORY]);
    #sortedPaths;
    #mutationVersion = 0;
    constructor(fs) {
        this.#fs = fs;
    }
    get mutationVersion() {
        return this.#mutationVersion;
    }
    async refreshPaths() {
        const paths = new Set([THREAD_GIT_DIRECTORY]);
        await this.#visit(THREAD_GIT_DIRECTORY, paths);
        this.#paths = paths;
        this.#sortedPaths = undefined;
    }
    recordExternalWrite(path) {
        this.#recordMutation();
        this.#addPath(resolveWorkspacePath(THREAD_GIT_DIRECTORY, path));
    }
    recordExternalRemove(path) {
        this.#recordMutation();
        this.#removePath(resolveWorkspacePath(THREAD_GIT_DIRECTORY, path));
    }
    recordRepositoryMutation() {
        this.#recordMutation();
    }
    async readFile(path, options) {
        const bytes = await this.readFileBuffer(path);
        const encoding = typeof options === "string" ? options : options?.encoding ?? "utf8";
        return decode(bytes, encoding);
    }
    async readFileBytes(path) {
        return bytesToLatin1(await this.readFileBuffer(path));
    }
    async readFileBuffer(path) {
        const absolute = resolveShellPath(THREAD_GIT_DIRECTORY, path);
        if (absolute === "/dev/null")
            return new Uint8Array();
        const value = await this.#fs.promises.readFile(absolute);
        return value instanceof Uint8Array ? value : utf8.encode(value);
    }
    async writeFile(path, content, options) {
        const absolute = resolveShellPath(THREAD_GIT_DIRECTORY, path);
        if (absolute === "/dev/null")
            return;
        await this.#fs.promises.writeFile(absolute, encode(content, options));
        this.#recordMutation();
        this.#addPath(absolute);
    }
    async appendFile(path, content, options) {
        const absolute = resolveShellPath(THREAD_GIT_DIRECTORY, path);
        if (absolute === "/dev/null")
            return;
        await this.#fs.promises.appendFile(absolute, encode(content, options));
        this.#recordMutation();
        this.#addPath(absolute);
    }
    async exists(path) {
        let absolute;
        try {
            absolute = resolveShellPath(THREAD_GIT_DIRECTORY, path);
        }
        catch (error) {
            if (isCode(error, "EPERM"))
                return false;
            throw error;
        }
        if (isShellDevice(absolute))
            return true;
        return this.#fs.promises.stat(absolute).then(() => true, () => false);
    }
    async stat(path) {
        const absolute = resolveShellPath(THREAD_GIT_DIRECTORY, path);
        if (isShellDevice(absolute)) {
            return {
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                mode: 0o666,
                size: 0,
                mtime: new Date(0),
            };
        }
        const result = await this.#fs.promises.stat(absolute);
        return {
            isFile: result.isFile(),
            isDirectory: result.isDirectory(),
            isSymbolicLink: result.isSymbolicLink(),
            mode: result.mode,
            size: result.size,
            mtime: new Date(result.mtimeMs),
        };
    }
    async mkdir(path) {
        const absolute = resolveWorkspacePath(THREAD_GIT_DIRECTORY, path);
        await this.#fs.promises.mkdir(absolute);
        this.#recordMutation();
        this.#addPath(absolute);
    }
    async readdir(path) {
        return this.#fs.promises.readdir(resolveWorkspacePath(THREAD_GIT_DIRECTORY, path));
    }
    async readdirWithFileTypes(path) {
        const absolute = resolveWorkspacePath(THREAD_GIT_DIRECTORY, path);
        return this.#fs.promises.readdirWithFileTypes(absolute);
    }
    async rm(path, options) {
        const absolute = resolveWorkspacePath(THREAD_GIT_DIRECTORY, path);
        let removed = false;
        try {
            await this.#fs.promises.rm(absolute, { recursive: options?.recursive });
            removed = true;
        }
        catch (error) {
            if (!options?.force || !isCode(error, "ENOENT"))
                throw error;
        }
        if (removed) {
            this.#recordMutation();
            this.#removePath(absolute);
        }
    }
    async cp(src, dest, options) {
        const source = resolveWorkspacePath(THREAD_GIT_DIRECTORY, src);
        const target = resolveWorkspacePath(THREAD_GIT_DIRECTORY, dest);
        const sourceStat = await this.stat(source);
        if (sourceStat.isDirectory) {
            if (!options?.recursive)
                throw fsError("EISDIR", "copying a directory requires recursive mode");
            await this.mkdir(target);
            for (const name of await this.readdir(source)) {
                await this.cp(`${source}/${name}`, `${target}/${name}`, options);
            }
            return;
        }
        await this.writeFile(target, await this.readFileBuffer(source));
    }
    async mv(src, dest) {
        const source = resolveWorkspacePath(THREAD_GIT_DIRECTORY, src);
        await this.cp(source, dest, { recursive: true });
        await this.rm(source, { recursive: true });
    }
    resolvePath(base, path) {
        return resolveShellPath(base, path);
    }
    getAllPaths() {
        this.#sortedPaths ??= [...this.#paths].sort();
        return this.#sortedPaths.slice();
    }
    async chmod(path) {
        await this.stat(path);
    }
    async symlink() {
        throw fsError("ENOSYS", "OPFS does not support symbolic links");
    }
    async link() {
        throw fsError("ENOSYS", "OPFS does not support hard links");
    }
    async readlink() {
        throw fsError("ENOSYS", "OPFS does not support symbolic links");
    }
    lstat(path) {
        return this.stat(path);
    }
    async realpath(path) {
        const absolute = resolveWorkspacePath(THREAD_GIT_DIRECTORY, path);
        await this.stat(absolute);
        return absolute;
    }
    async utimes(path) {
        await this.stat(path);
    }
    async #visit(directory, paths) {
        for (const entry of await this.readdirWithFileTypes(directory)) {
            if (directory === THREAD_GIT_DIRECTORY && entry.name === ".git")
                continue;
            const path = `${directory}/${entry.name}`;
            this.#addIndexedPath(paths, path);
            if (entry.isDirectory)
                await this.#visit(path, paths);
        }
    }
    #addPath(path) {
        const gitDirectory = `${THREAD_GIT_DIRECTORY}/.git`;
        if (path === gitDirectory || path.startsWith(`${gitDirectory}/`))
            return;
        const segments = path.slice(THREAD_GIT_DIRECTORY.length + 1).split("/");
        let current = THREAD_GIT_DIRECTORY;
        let changed = false;
        for (const segment of segments) {
            if (!segment)
                continue;
            current += `/${segment}`;
            changed = this.#addIndexedPath(this.#paths, current) || changed;
        }
        if (changed)
            this.#sortedPaths = undefined;
    }
    #addIndexedPath(paths, path) {
        if (paths.has(path))
            return false;
        if (paths.size >= MAX_INDEXED_PATHS) {
            throw fsError("EFBIG", `browser shell path index exceeds ${MAX_INDEXED_PATHS} entries`);
        }
        paths.add(path);
        return true;
    }
    #removePath(path) {
        let changed = false;
        for (const candidate of this.#paths) {
            if (candidate === path || candidate.startsWith(`${path}/`)) {
                this.#paths.delete(candidate);
                changed = true;
            }
        }
        if (changed)
            this.#sortedPaths = undefined;
    }
    #recordMutation() {
        this.#mutationVersion += 1;
    }
}
const SHELL_DEVICES = new Set(["/dev/full", "/dev/null", "/dev/stderr", "/dev/stdout"]);
function isShellDevice(path) {
    return SHELL_DEVICES.has(path);
}
function resolveShellPath(base, path) {
    if (isShellDevice(path))
        return path;
    return resolveWorkspacePath(base, path);
}
function resolveWorkspacePath(base, path) {
    if (typeof path !== "string" || path.includes("\0"))
        throw fsError("EINVAL", "invalid path");
    const source = path.startsWith("/") ? path : `${base}/${path}`;
    const segments = [];
    for (const segment of source.replace(/\\/g, "/").split("/")) {
        if (!segment || segment === ".")
            continue;
        if (segment === "..")
            segments.pop();
        else
            segments.push(segment);
    }
    const absolute = `/${segments.join("/")}`;
    if (absolute !== THREAD_GIT_DIRECTORY && !absolute.startsWith(`${THREAD_GIT_DIRECTORY}/`)) {
        throw fsError("EPERM", `path escapes ${THREAD_GIT_DIRECTORY}`);
    }
    return absolute;
}
function encode(content, options) {
    if (content instanceof Uint8Array)
        return content;
    const encoding = typeof options === "string" ? options : options?.encoding ?? "utf8";
    if (encoding === "base64")
        return Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
    if (encoding === "hex") {
        if (content.length % 2 !== 0 || !/^[a-f0-9]*$/i.test(content))
            throw fsError("EINVAL", "invalid hex input");
        return Uint8Array.from(content.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
    }
    if (encoding === "binary" || encoding === "latin1" || encoding === "ascii") {
        return Uint8Array.from(content, (character) => character.charCodeAt(0) & 0xff);
    }
    return utf8.encode(content);
}
function decode(bytes, encoding) {
    if (encoding === "base64")
        return btoa(bytesToLatin1(bytes));
    if (encoding === "hex")
        return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (encoding === "binary" || encoding === "latin1")
        return bytesToLatin1(bytes);
    if (encoding === "ascii")
        return String.fromCharCode(...bytes.map((byte) => byte & 0x7f));
    return utf8Decoder.decode(bytes);
}
function bytesToLatin1(bytes) {
    let output = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
        output += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return output;
}
function requireString(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new TypeError(`${name} must be a non-empty string`);
    return value;
}
function optionalPositiveInteger(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value <= 0)
        throw new TypeError("max_output_tokens must be positive");
    return Math.min(value, 100_000);
}
function firstLine(value) {
    return value.trim().split("\n", 1)[0] ?? "";
}
function flagValue(args, flag) {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isCode(error, code) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
function fsError(code, message) {
    return Object.assign(new Error(message), { code });
}
