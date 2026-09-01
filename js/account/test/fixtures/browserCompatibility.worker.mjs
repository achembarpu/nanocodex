import git from "isomorphic-git";
import {
  Agent as BrowserAgent,
  Transport as BrowserTransport,
} from "nanocodex/host";
import {
  createBrowserBash,
  createOpfsGitFs,
  openOpfsWorkspaceRoot,
} from "nanocodex/tools/browser";

const workspaceName = `nanocodex-safari-smoke-${crypto.randomUUID()}`;

try {
  const workspaceRoot = await openOpfsWorkspaceRoot(workspaceName);
  const fs = createOpfsGitFs(workspaceRoot);
  await fs.promises.mkdir("/workspace");
  await git.init({ fs, dir: "/workspace", defaultBranch: "nanocodex" });
  const thread = {
    id: crypto.randomUUID(),
    workspaceName,
    repositoryName: "safari-smoke",
    branch: "nanocodex",
    remoteUrl: "https://example.test/git/safari-smoke",
    shareUrl: "https://example.test/?thread=safari-smoke",
  };
  const shell = await createBrowserBash(fs, thread, { workspaceRoot });
  const agent = await BrowserAgent.create({
    transport: BrowserTransport.hostManaged({
      websocketWarmup: false,
      createWebSocket() {
        throw new Error("Safari smoke must not open a model socket");
      },
    }),
    workspace: "/workspace",
    tools: [{
      name: "exec_command",
      description: "Run a local command in the browser workspace.",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      },
      handler: (input, context) => shell.exec(input, context),
    }],
  });
  let gzip;
  let gitStatus;
  try {
    gzip = await shell.exec({
      cmd: "printf 'stable safari gzip\\n' > input.txt && gzip -c input.txt > input.txt.gz && gzip -dc input.txt.gz",
    });
    if (gzip.exit_code !== 0 || gzip.output !== "stable safari gzip\n") {
      throw new Error(`gzip smoke failed: ${JSON.stringify(gzip)}`);
    }
    gitStatus = await shell.exec({ cmd: "git status --short" });
    if (gitStatus.exit_code !== 0 || !gitStatus.output.includes("input.txt")) {
      throw new Error(`git smoke failed: ${JSON.stringify(gitStatus)}`);
    }
  } finally {
    await agent.session.shutdown();
  }
  postMessage({
    ok: true,
    agent: agent.type,
    gzip: gzip.output,
    git: gitStatus.output,
  });
} catch (error) {
  postMessage({
    ok: false,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
} finally {
  try {
    const origin = await navigator.storage.getDirectory();
    const workspaces = await origin.getDirectoryHandle("nanocodex-workspaces");
    await workspaces.removeEntry(encodeURIComponent(workspaceName), { recursive: true });
  } catch {
    // The test workspace is unique and a failed best-effort cleanup must not
    // hide the compatibility result that the harness was asked to capture.
  }
}
