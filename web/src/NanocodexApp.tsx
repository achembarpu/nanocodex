"use client";

import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  GitBranch,
  GitPullRequest,
  Moon,
  Search,
  Sun,
  X,
} from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
import type { CodeBrowserHandle } from "./CodeBrowser";
import type { CommitCodeStreamHandle } from "./CommitCodeStream";
import { evalApi } from "./evalApi";
import { fuzzyScore } from "./fuzzy";
import { pathForSurface, surfaceFromUrl, type Surface } from "./navigation";
import type { PublishedRepositorySnapshot } from "./publishedRepository";
import type { HarnessCommit } from "./threadRepositorySnapshot";
import { getBrowserThread } from "nanocodex/tools/browser";

const loadEvals = () =>
  import("./Evals").then((module) => ({ default: module.Evals }));
const Evals = lazy(loadEvals);
const Docs = lazy(() =>
  import("./Docs").then((module) => ({ default: module.Docs }))
);
const HomeFrame = lazy(() =>
  import("./HomeFrame").then((module) => ({ default: module.HomeFrame }))
);
const AgentTerminal = lazy(() =>
  import("./AgentTerminal").then((module) => ({
    default: module.AgentTerminal,
  }))
);
const PierreWorkerProvider = lazy(() =>
  import("./PierreWorkerProvider").then((module) => ({
    default: module.PierreWorkerProvider,
  }))
);
const CodeBrowser = lazy(() =>
  import("./CodeBrowser").then((module) => ({ default: module.CodeBrowser }))
);
const CommitCodeStream = lazy(() =>
  import("./CommitCodeStream").then((module) => ({
    default: module.CommitCodeStream,
  }))
);
const VirtualCommitList = lazy(() =>
  import("./VirtualCommitList").then((module) => ({
    default: module.VirtualCommitList,
  })),
);

export type Theme = "light" | "dark";
type Scope = "all" | "eval" | "fix" | "docs" | "perf";
type ProposalState = "ready" | "submitting" | "payment-required";

const emptyCommits: HarnessCommit[] = [];
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 30 * 60 * 1_000,
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});

function preloadEvalOverview() {
  void loadEvals().catch(() => undefined);
  void Promise.all([
    queryClient.prefetchQuery({
      queryKey: ["evals", "overview"],
      queryFn: ({ signal }) => evalApi.overview(signal),
    }),
    queryClient.prefetchQuery({
      queryKey: ["evals", "cluster"],
      queryFn: ({ signal }) => evalApi.cluster(signal),
      staleTime: 5_000,
    }),
  ]).catch(() => undefined);
}

function loadRepositorySnapshot(
  includeHistory: boolean,
): Promise<PublishedRepositorySnapshot> {
  return import("./publishedRepository")
    .then((module) => module.loadPublishedRepositorySnapshot(includeHistory));
}

const scopes: Array<{ id: Scope; label: string }> = [
  { id: "all", label: "All commits" },
  { id: "eval", label: "Eval" },
  { id: "fix", label: "Fix" },
  { id: "docs", label: "Docs" },
  { id: "perf", label: "Perf" },
];

function subjectScope(subject: string) {
  const prefix = subject.split(":", 1)[0].toLowerCase();
  return scopes.some(({ id }) => id === prefix) ? (prefix as Scope) : "other";
}

function commitSearchScore(commit: HarnessCommit, tokens: readonly string[]) {
  if (!tokens.length) return 0;
  const fields = [
    { value: commit.hash, weight: 160 },
    { value: commit.subject, weight: 120 },
    { value: commit.author, weight: 60 },
    { value: commit.body, weight: 30 },
    ...commit.files.map((file) => ({ value: file.path, weight: 90 })),
  ];

  let total = 0;
  for (const token of tokens) {
    const best = fields.reduce<number | null>((current, field) => {
      const score = fuzzyScore(field.value, token);
      if (score === null) return current;
      const weighted = score + field.weight;
      return current === null || weighted > current ? weighted : current;
    }, null);
    if (best === null) return null;
    total += best;
  }
  return total;
}

const installCommand =
  "curl -fsSL https://nanocodex.paradigm.xyz | bash";

function RepositorySurfaceError({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry(): void;
}) {
  if (!failed) return null;
  return (
    <section className="requests-empty page-grid" role="alert">
      <GitBranch aria-hidden="true" />
      <p className="eyebrow">Repository</p>
      <h1>Published repository unavailable.</h1>
      <p>The Code and Commits publication could not be loaded.</p>
      <button className="button button--medium" type="button" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

export function NanocodexApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <NanocodexShell />
    </QueryClientProvider>
  );
}

function NanocodexShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<Theme>(() => {
    const initialTheme = document.documentElement.dataset.theme;
    if (initialTheme === "dark" || initialTheme === "light")
      return initialTheme;
    const stored =
      localStorage.getItem("nanocodex-theme");
    return stored === "dark" ? "dark" : "light";
  });
  const surface = surfaceFromUrl({
    pathname: location.pathname,
    searchParams: new URLSearchParams(location.search),
  });
  const [threadId, setThreadId] = useState<string | undefined>(() =>
    surface === "docs" ? undefined : getBrowserThread().id
  );
  const [snapshot, setSnapshot] = useState<PublishedRepositorySnapshot>();
  const [repositoryLoadError, setRepositoryLoadError] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedHash, setSelectedHash] = useState<string>();
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalState, setProposalState] = useState<ProposalState>("ready");
  const [proposalTitle, setProposalTitle] = useState("");
  const [commitRailOpen, setCommitRailOpen] = useState(false);
  const [installCopied, setInstallCopied] = useState(false);
  const needsRepository = surface === "code" || surface === "commits" || proposalOpen;
  const needsRepositoryHistory = surface === "commits" || proposalOpen;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const headerCenterRef = useRef<HTMLDivElement>(null);
  const codeBrowserRef = useRef<CodeBrowserHandle>(null);
  const commitStreamRef = useRef<CommitCodeStreamHandle>(null);
  const repositoryRequestId = useRef(0);

  const commits = snapshot?.commits ?? emptyCommits;
  const selected = useMemo(
    () =>
      commits.find((commit) => commit.hash === selectedHash) ??
      commits[0] ??
      null,
    [commits, selectedHash],
  );
  const scopeCounts = useMemo(
    () =>
      commits.reduce<Record<Scope, number>>(
        (counts, commit) => {
          const commitScope = subjectScope(commit.subject);
          if (commitScope !== "other") counts[commitScope] += 1;
          return counts;
        },
        {
          all: commits.length,
          eval: 0,
          fix: 0,
          docs: 0,
          perf: 0,
        },
      ),
    [commits],
  );
  const queryTokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const filteredCommits = useMemo(() => {
    const scoped = commits.filter(
      (commit) => scope === "all" || subjectScope(commit.subject) === scope,
    );
    if (!queryTokens.length) return scoped;
    return scoped
      .map((commit) => ({
        commit,
        score: commitSearchScore(commit, queryTokens),
      }))
      .filter(
        (match): match is { commit: HarnessCommit; score: number } =>
          match.score !== null,
      )
      .sort((left, right) => right.score - left.score)
      .map((match) => match.commit);
  }, [commits, queryTokens, scope]);

  const searchResults = useMemo(
    () => {
      if (!searchOpen) return [];
      return commits
        .map((commit) => ({
          commit,
          score: commitSearchScore(commit, queryTokens),
        }))
        .filter(
          (match): match is { commit: HarnessCommit; score: number } =>
            match.score !== null,
        )
        .sort((left, right) => right.score - left.score)
        .slice(0, 12)
        .map((match) => match.commit);
    },
    [commits, queryTokens, searchOpen],
  );

  const refreshRepository = useCallback(() => {
    if (!needsRepository) return;
    const requestId = ++repositoryRequestId.current;
    setRepositoryLoadError(false);
    void loadRepositorySnapshot(needsRepositoryHistory).then(
      (loaded) => {
        if (repositoryRequestId.current !== requestId) return;
        setSnapshot(loaded);
        setSelectedHash((current) => current && loaded.commits.some(({ hash }) => hash === current)
          ? current
          : loaded.repository.head);
      },
      () => {
        if (
          repositoryRequestId.current === requestId
        ) {
          setRepositoryLoadError(true);
        }
      },
    );
  }, [needsRepository, needsRepositoryHistory]);

  useEffect(() => {
    if (!needsRepository) {
      repositoryRequestId.current++;
      setSnapshot(undefined);
      setRepositoryLoadError(false);
      return;
    }
    if (!snapshot || (needsRepositoryHistory && !snapshot.historyLoaded)) {
      refreshRepository();
    }
  }, [needsRepository, needsRepositoryHistory, refreshRepository, snapshot]);

  useEffect(() => () => {
    repositoryRequestId.current++;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#161616" : "#ffffff");
    localStorage.setItem("nanocodex-theme", theme);
  }, [theme]);

  const threadSurfacePath = useCallback(
    (nextSurface: Surface) =>
      threadId
        ? `${pathForSurface(nextSurface)}?thread=${threadId}`
        : pathForSurface(nextSurface),
    [threadId],
  );
  const navigateToSurface = useCallback((nextSurface: Surface) => {
    if (nextSurface === "evals") preloadEvalOverview();
    if (nextSurface === "docs") {
      startTransition(() => navigate(pathForSurface(nextSurface)));
      return;
    }
    const nextThreadId = threadId ?? getBrowserThread().id;
    if (!threadId) setThreadId(nextThreadId);
    startTransition(() =>
      navigate(`${pathForSurface(nextSurface)}?thread=${nextThreadId}`)
    );
  }, [navigate, threadId]);

  useLayoutEffect(() => {
    const headerCenter = headerCenterRef.current;
    const activeButton =
      headerCenter?.querySelector<HTMLButtonElement>(".is-active");
    if (
      !headerCenter ||
      !activeButton ||
      headerCenter.scrollWidth <= headerCenter.clientWidth
    )
      return;
    headerCenter.scrollLeft =
      activeButton.offsetLeft -
      (headerCenter.clientWidth - activeButton.offsetWidth) / 2;
  }, [surface]);

  useEffect(() => {
    if (searchOpen)
      requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const originalTarget = event.composedPath()[0];
      const target =
        originalTarget instanceof HTMLElement
          ? originalTarget
          : (event.target as HTMLElement | null);
      const isTyping = target?.matches(
        "input, textarea, [contenteditable='true']"
      );
      const primaryModifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (
        surface === "code" &&
        primaryModifier &&
        !event.altKey &&
        key === "p"
      ) {
        event.preventDefault();
        event.stopPropagation();
        codeBrowserRef.current?.openTreeSearch();
        return;
      }
      if (
        surface === "code" &&
        primaryModifier &&
        !event.altKey &&
        key === "f"
      ) {
        event.preventDefault();
        event.stopPropagation();
        codeBrowserRef.current?.openFileSearch();
        return;
      }

      if (event.key === "Escape") {
        setSearchOpen(false);
        setProposalOpen(false);
        setCommitRailOpen(false);
        codeBrowserRef.current?.closeSearches();
        return;
      }
      if (isTyping || primaryModifier || event.altKey) return;
      if (key === "f") {
        if (surface !== "commits") return;
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        return;
      }
      if (key === "m") {
        event.preventDefault();
        event.stopPropagation();
        setTheme((current) => (current === "light" ? "dark" : "light"));
        return;
      }
      if (key === "p") {
        event.preventDefault();
        event.stopPropagation();
        setProposalState("ready");
        setProposalOpen(true);
        return;
      }
      const nextSurface =
        key === "h"
          ? "home"
          : key === "d"
          ? "docs"
          : key === "t"
          ? "code"
          : key === "c"
          ? "commits"
          : key === "r"
          ? "requests"
          : key === "e"
          ? "evals"
          : null;
      if (nextSurface) {
        event.preventDefault();
        event.stopPropagation();
        target?.blur();
        navigateToSurface(nextSurface);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [navigateToSurface, surface]);

  const selectCommit = (commit: HarnessCommit) => {
    const index = commits.findIndex(
      (candidate) => candidate.hash === commit.hash
    );
    setSelectedHash(commit.hash);
    setSearchOpen(false);
    setCommitRailOpen(false);
    setQuery("");
    if (index >= 0) commitStreamRef.current?.scrollToCommit(index);
  };

  const submitProposal = async () => {
    if (!snapshot || !selected) return;
    setProposalState("submitting");
    try {
      await fetch("/api/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repository: snapshot.repository.fullName,
          base: selected.hash,
          title: proposalTitle || "Untitled proposal",
        }),
      });
    } finally {
      setProposalState("payment-required");
    }
  };

  return (
    <div className={`site-shell surface-${surface}`}>
        <header className="site-header">
          <a
            className="wordmark"
            href={threadSurfacePath("home")}
            aria-label="nanocodex home"
            onClick={(event) => {
              event.preventDefault();
              navigateToSurface("home");
            }}
          >
            nanocodex <span>[H]</span>
          </a>
          <div className="header-center" ref={headerCenterRef}>
            <nav className="surface-switch" aria-label="Product navigation">
              <a
                className={surface === "code" ? "is-active" : ""}
                href={threadSurfacePath("code")}
                onClick={(event) => {
                  event.preventDefault();
                  navigateToSurface("code");
                }}
              >
                Code <span>[T]</span>
              </a>
              <a
                className={surface === "commits" ? "is-active" : ""}
                href={threadSurfacePath("commits")}
                onClick={(event) => {
                  event.preventDefault();
                  navigateToSurface("commits");
                }}
              >
                Commits <span>[C]</span>
              </a>
              <a
                className={surface === "requests" ? "is-active" : ""}
                href={threadSurfacePath("requests")}
                onClick={(event) => {
                  event.preventDefault();
                  navigateToSurface("requests");
                }}
              >
                Requests <span>[R]</span>
              </a>
              <a
                className={surface === "evals" ? "is-active" : ""}
                href={threadSurfacePath("evals")}
                onFocus={preloadEvalOverview}
                onPointerEnter={preloadEvalOverview}
                onClick={(event) => {
                  event.preventDefault();
                  navigateToSurface("evals");
                }}
              >
                Evals <span>[E]</span>
              </a>
              <a
                className={surface === "docs" ? "docs-nav is-active" : "docs-nav"}
                href="/docs"
                onClick={(event) => {
                  event.preventDefault();
                  navigateToSurface("docs");
                }}
              >
                Docs <span>[D]</span>
              </a>
            </nav>
          </div>
          <nav className="header-actions" aria-label="Site actions">
            <button
              className="text-action"
              type="button"
              onClick={() =>
                setTheme((current) => (current === "light" ? "dark" : "light"))
              }
              aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}
            >
              {theme === "light" ? (
                <Moon aria-hidden="true" />
              ) : (
                <Sun aria-hidden="true" />
              )}
              <span>Theme</span>
              <span className="keycap">[M]</span>
            </button>
            <button
              className="button button--medium header-propose"
              type="button"
              onClick={() => {
                setProposalState("ready");
                setProposalOpen(true);
              }}
            >
              Propose <span>[P]</span>
            </button>
          </nav>
        </header>

        <main id="top">
          {surface === "home" ? (
            <Suspense fallback={null}>
            <HomeFrame>
            <section className="home-page" aria-labelledby="home-title">
              <article className="home-article">
                <header className="home-intro">
                  <div className="home-status-line" aria-label="Nanocodex product scope">
                    <span>OpenAI agent SDK</span>
                    <span>Rust · JavaScript · Python</span>
                    <span>Verifier-backed</span>
                  </div>
                  <div className="home-intro-grid">
                    <p className="home-index">00 / Premise</p>
                    <div className="home-intro-copy">
                      <h1 id="home-title">The coding agent is the library.</h1>
                      <p className="home-deck">
                        Nanocodex puts the complete coding loop inside your
                        product: retained sessions, typed history, tools,
                        branches, events, retries, and cleanup. You keep the
                        interface, data, memory, infrastructure, and policy.
                      </p>
                      <nav className="home-actions" aria-label="Get started">
                        <a href="#agent-demo">Run it here <ChevronRight aria-hidden="true" /></a>
                        <a href="/docs/getting-started">Embed an agent <ChevronRight aria-hidden="true" /></a>
                        <a href="https://github.com/gakonst/nanocodex" target="_blank" rel="noreferrer">
                          Source <ArrowUpRight aria-hidden="true" />
                        </a>
                      </nav>
                    </div>
                  </div>
                </header>

                <section className="home-demo" id="agent-demo" aria-labelledby="agent-demo-title">
                  <div className="home-chapter-heading">
                    <p className="home-index">01 / Live system</p>
                    <div>
                      <p className="eyebrow">Browser agent</p>
                      <h2 id="agent-demo-title">Not a recording. Not a chat wrapper.</h2>
                      <p>
                        The Rust lifecycle below is really running as WebAssembly
                        in a Worker against a persistent browser workspace.
                        Connect with ChatGPT or an API key; credentials stay
                        behind your transport.
                      </p>
                    </div>
                  </div>
                  <Suspense fallback={null}>
                    <AgentTerminal />
                  </Suspense>
                  <dl className="home-demo-ledger">
                    <div><dt>Engine</dt><dd>Rust → WASM Worker</dd></div>
                    <div><dt>Workspace</dt><dd>OPFS · shell · Git · artifacts</dd></div>
                    <div><dt>Interface</dt><dd>Headless events · bring any renderer</dd></div>
                  </dl>
                </section>

                <section className="home-chapter home-boundary" aria-labelledby="home-boundary-title">
                  <div className="home-chapter-heading">
                    <p className="home-index">02 / Boundary</p>
                    <div>
                      <p className="eyebrow">One owned lifecycle</p>
                      <h2 id="home-boundary-title">Embed the hard parts. Keep the product.</h2>
                      <p>
                        One private driver owns mutable conversation, model,
                        transport, and tool state. The public API stays small
                        because callers should express policy, not replay internals.
                      </p>
                    </div>
                  </div>
                  <div className="home-ownership">
                    <article>
                      <p>Nanocodex owns</p>
                      <ul>
                        <li>Prompt ordering and independently awaitable turns</li>
                        <li>Committed typed history and persistent WebSocket reuse</li>
                        <li>Tool execution, Code Mode, deferred MCP discovery</li>
                        <li>Retries, compaction, branches, snapshots, cancellation</li>
                        <li>Process-group cleanup and optional durable recovery</li>
                      </ul>
                    </article>
                    <article>
                      <p>Your product owns</p>
                      <ul>
                        <li>Interface, interaction model, tenancy, and authorization</li>
                        <li>Tools, workspace, sandbox, egress, and secrets</li>
                        <li>Persistence, memory governance, review, and telemetry</li>
                        <li>Deployment on native, browser, Workflow, Workers, or Actors</li>
                        <li>The opinionated experience users actually touch</li>
                      </ul>
                    </article>
                  </div>
                  <div className="home-lifecycle" aria-label="Agent lifecycle">
                    <code>prompt → Turn → TurnResult</code>
                    <span>+</span>
                    <code>AgentEvents → UI · storage · telemetry</code>
                  </div>
                </section>

                <section className="home-chapter home-bindings" aria-labelledby="home-bindings-title">
                  <div className="home-chapter-heading">
                    <p className="home-index">03 / Surfaces</p>
                    <div>
                      <p className="eyebrow">Same agent, thin bindings</p>
                      <h2 id="home-bindings-title">Start at the boundary you already own.</h2>
                      <p>
                        Follow-on prompts reuse history, tools, socket, and cache
                        identity automatically. No binding asks you to pass old
                        messages, response IDs, or tool results back in.
                      </p>
                    </div>
                  </div>
                  <div className="home-binding-ledger">
                    <article><span>Rust</span><code>Nanocodex::builder(openai)</code><p>Typed turns, optional events, Tower middleware, and the complete owned lifecycle.</p><a href="/docs/sdks/rust">Rust SDK <ChevronRight aria-hidden="true" /></a></article>
                    <article><span>JavaScript</span><code>{"Agent.create({ transport })"}</code><p>Viem-style actions for Node and browser WASM, plus headless React ownership.</p><a href="/docs/sdks/javascript">JavaScript SDK <ChevronRight aria-hidden="true" /></a></article>
                    <article><span>Python</span><code>Nanocodex(api_key)</code><p>A typed PyO3 adapter over the native Rust session—not a second agent implementation.</p><a href="/docs/sdks/python">Python SDK <ChevronRight aria-hidden="true" /></a></article>
                  </div>
                  <div className="home-web-proof">
                    <div>
                      <p className="eyebrow">The web is a real host</p>
                      <h3>Build a capable agent without provisioning a remote sandbox.</h3>
                      <p>
                        Browser JavaScript can host the Rust agent and an OPFS
                        workspace directly. Lazy tools add just-bash, Python,
                        C/C++, canonical apply_patch, Git and gh, bounded dataset
                        inspection, image generation, web search, and live React
                        artifacts.
                      </p>
                      <p className="home-caveat">
                        Local browser execution is convenience, not isolation.
                        Choose a retained VM or hosted sandbox when the workload
                        needs a security boundary.
                      </p>
                    </div>
                    <pre aria-label="JavaScript agent example"><code>{`const agent = await Agent.create({ transport })
await agent.prompt("inspect this workspace")
const result = await agent.result()`}</code></pre>
                  </div>
                </section>

                <section className="home-chapter home-tact" aria-labelledby="home-tact-title">
                  <div className="home-chapter-heading">
                    <p className="home-index">04 / Built on it</p>
                    <div>
                      <p className="eyebrow">Tact</p>
                      <h2 id="home-tact-title">A complete product around a deliberately incomplete SDK.</h2>
                      <p>
                        Tact composes retained sessions, tools, branches, events,
                        and optional task trees into its own terminal agent. Its
                        durable index, skills, reflection, review, authorization,
                        and memory system stay application-owned.
                      </p>
                    </div>
                  </div>
                  <div className="home-tact-grid">
                    <article>
                      <span>Composition</span>
                      <p>Nanocodex lifecycle + typed tools</p>
                      <span className="home-flow-arrow">↓</span>
                      <p>Tact session envelope + extensions</p>
                      <span className="home-flow-arrow">↓</span>
                      <p>Terminal, review, memory, and product policy</p>
                    </article>
                    <article>
                      <span>Memory with authority</span>
                      <p>
                        Memory is selected by the application, never silently
                        injected. Tact uses exact versioned keys, explicit
                        scan-before-put behavior, root-write/child-read policy,
                        and no quiet remote fallback.
                      </p>
                      <a href="/docs/examples/tact">Read the Tact case study <ChevronRight aria-hidden="true" /></a>
                      <a href="https://github.com/clabby/tact" target="_blank" rel="noreferrer">Open Tact <ArrowUpRight aria-hidden="true" /></a>
                    </article>
                  </div>
                  <a className="home-inline-proof" href="https://github.com/gakonst/nanocodex/tree/master/examples/vercel-workflows" target="_blank" rel="noreferrer">
                    See one headless agent rendered through @wterm/react—with the same stream ready for xterm.js or custom React
                    <ArrowUpRight aria-hidden="true" />
                  </a>
                </section>

                <section className="home-chapter home-evidence" aria-labelledby="home-evidence-title">
                  <div className="home-chapter-heading">
                    <p className="home-index">05 / Evidence</p>
                    <div>
                      <p className="eyebrow">Verifier-backed, artifact-retained</p>
                      <h2 id="home-evidence-title">Claims come with the work that produced them.</h2>
                      <p>
                        Fresh VM overlays run the agent and canonical verifier.
                        Result JSON, raw events, trajectories, API exchanges,
                        verifier output, usage, cost, and infrastructure evidence
                        remain inspectable.
                      </p>
                    </div>
                  </div>
                  <div className="home-metrics">
                    <article><strong>39 / 39</strong><span>latency gates</span><p>Retained PR #50 release evidence. A performance gate, not a task-quality score.</p></article>
                    <article><strong>0.267 ms</strong><span>median local overhead</span><p>Paired 70-turn workload; 97.879% of measured time was reported model work.</p></article>
                    <article><strong>13 / 20</strong><span>attempts · 8m15s</span><p>Frozen four-task Terminal-Bench 2.1 slice. Historical baseline, not a leaderboard claim.</p></article>
                  </div>
                  <nav className="home-proof-links" aria-label="Inspect Nanocodex evidence">
                    <a href={threadSurfacePath("evals")} onFocus={preloadEvalOverview} onPointerEnter={preloadEvalOverview} onClick={(event) => { event.preventDefault(); navigateToSurface("evals"); }}>Live evals <ArrowUpRight aria-hidden="true" /></a>
                    <a href="/docs/evals">Evaluation contract <ChevronRight aria-hidden="true" /></a>
                    <a href={threadSurfacePath("code")} onClick={(event) => { event.preventDefault(); navigateToSurface("code"); }}>Source <ArrowUpRight aria-hidden="true" /></a>
                    <a href={threadSurfacePath("commits")} onClick={(event) => { event.preventDefault(); navigateToSurface("commits"); }}>Commit record <ArrowUpRight aria-hidden="true" /></a>
                  </nav>
                </section>

                <section className="home-chapter home-doc-paths" aria-labelledby="home-docs-title">
                  <div className="home-chapter-heading">
                    <p className="home-index">06 / Manual</p>
                    <div>
                      <p className="eyebrow">Documentation</p>
                      <h2 id="home-docs-title">Read by the job you are doing.</h2>
                    </div>
                  </div>
                  <div className="home-path-grid">
                    <article><span>Try it</span><a href="/docs/getting-started">Getting started</a><a href="/docs/capabilities/web-agent">Web agent</a></article>
                    <article><span>Embed it</span><a href="/docs/core/owned-agent">Owned lifecycle</a><a href="/docs/core/tools-code-mode">Tools and Code Mode</a></article>
                    <article><span>Verify it</span><a href="/docs/stability">Stability and scope</a><a href="/docs/evals">Evaluation</a></article>
                  </div>
                </section>

                <section className="home-release-section" aria-labelledby="home-release-title">
                  <div className="home-release-heading">
                    <div>
                      <p className="home-index">07 / Start</p>
                      <h2 id="home-release-title">Choose your host.</h2>
                    </div>
                    <a href="https://github.com/gakonst/nanocodex/releases/latest" target="_blank" rel="noreferrer">
                      Latest release <ArrowUpRight aria-hidden="true" />
                    </a>
                  </div>
                  <div className="home-hosts">
                    <div><span>Rust</span><code>cargo add nanocodex</code></div>
                    <div><span>JavaScript</span><code>npm install nanocodex</code></div>
                    <div><span>Native consumer</span><code>{installCommand}</code></div>
                  </div>
                  <button className="home-copy-install" type="button" aria-label="Copy install command" onClick={() => { void navigator.clipboard.writeText(installCommand).then(() => { setInstallCopied(true); window.setTimeout(() => setInstallCopied(false), 1_500); }); }}>
                    {installCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {installCopied ? "Copied CLI command" : "Copy CLI command"}
                  </button>
                </section>
              </article>
            </section>
            </HomeFrame>
            </Suspense>
          ) : surface === "docs" ? (
            <Suspense fallback={null}>
              <Docs />
            </Suspense>
          ) : surface === "code" ? snapshot ? (
            <Suspense fallback={null}>
              <PierreWorkerProvider>
                  <CodeBrowser
                    key={snapshot.repository.head}
                    ref={codeBrowserRef}
                    files={snapshot.tree}
                    branch={snapshot.repository.branch}
                    head={snapshot.repository.head}
                    readFile={snapshot.readFile}
                    theme={theme}
                  />
              </PierreWorkerProvider>
            </Suspense>
          ) : (
            <RepositorySurfaceError
              failed={repositoryLoadError}
              onRetry={refreshRepository}
            />
          ) : surface === "commits" ? snapshot?.historyLoaded ? (
            <Suspense fallback={null}>
              <PierreWorkerProvider>
                <section
                  className="commits-workspace"
                  aria-label="Repository commits"
                >
                <button
                  className={
                    commitRailOpen
                      ? "workspace-backdrop is-visible"
                      : "workspace-backdrop"
                  }
                  type="button"
                  aria-label="Close commit list"
                  onClick={() => setCommitRailOpen(false)}
                />
                <aside
                  className={
                    commitRailOpen
                      ? "commit-sidebar is-mobile-open"
                      : "commit-sidebar"
                  }
                  aria-labelledby="history-title"
                >
                  <header className="commit-sidebar-header">
                    <div>
                      <strong id="history-title">Jump to commit</strong>
                      <span>
                        <GitBranch aria-hidden="true" />{" "}
                        {snapshot.repository.branch} · {snapshot.commits.length}
                      </span>
                    </div>
                    <nav
                      className="commit-sidebar-actions"
                      aria-label="Commit index actions"
                    >
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => setSearchOpen(true)}
                      >
                        <Search aria-hidden="true" />
                        <span className="sr-only">Find commits</span>
                        <kbd>F</kbd>
                      </button>
                      <button
                        className="mobile-drawer-close"
                        type="button"
                        onClick={() => setCommitRailOpen(false)}
                        aria-label="Close commit index"
                      >
                        <X aria-hidden="true" />
                      </button>
                    </nav>
                  </header>

                  <nav
                    className="commit-scope-tabs"
                    aria-label="Quick jump scopes"
                  >
                    {scopes.map((item) => (
                      <button
                        className={scope === item.id ? "is-active" : ""}
                        type="button"
                        key={item.id}
                        onClick={() => setScope(item.id)}
                      >
                      {item.label} <span>{scopeCounts[item.id]}</span>
                      </button>
                    ))}
                  </nav>

                  {query ? (
                    <div className="commit-query">
                      <span>
                        {filteredCommits.length} matches for “{query}”
                      </span>
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        aria-label="Clear commit search"
                      >
                        <X aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}

                  <Suspense fallback={null}>
                    <VirtualCommitList
                      commits={filteredCommits}
                      selectedHash={selected?.hash}
                      onClearSearch={() => setQuery("")}
                      onSelectCommit={selectCommit}
                    />
                  </Suspense>
                </aside>
                <Suspense fallback={null}>
                  <CommitCodeStream
                    ref={commitStreamRef}
                    commits={commits}
                    onOpenCommitRail={() => setCommitRailOpen(true)}
                    patchUrl={snapshot.commitPatchUrl}
                    theme={theme}
                  />
                </Suspense>
                </section>
              </PierreWorkerProvider>
            </Suspense>
          ) : (
            <RepositorySurfaceError
              failed={repositoryLoadError}
              onRetry={refreshRepository}
            />
          ) : surface === "requests" ? (
            <section
              className="requests-empty page-grid"
              aria-labelledby="requests-title"
            >
              <GitPullRequest aria-hidden="true" />
              <p className="eyebrow">Requests</p>
              <h1 id="requests-title">No requests yet.</h1>
              <p>
                This view is reserved for proposed changes. We’ll leave it quiet
                for now.
              </p>
            </section>
          ) : (
            <Suspense fallback={null}>
              <Evals />
            </Suspense>
          )}
        </main>

        {searchOpen && surface === "commits" ? (
          <div
            className="overlay"
            role="presentation"
            onMouseDown={() => setSearchOpen(false)}
          >
            <section
              className="search-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Find commits"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="search-field">
                <Search aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search hashes, messages, authors, and paths"
                />
                <button
                  type="button"
                  onClick={() => setSearchOpen(false)}
                  aria-label="Close search"
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <div className="search-results">
                {searchResults.length ? (
                  searchResults.map((commit, index) => (
                    <button
                      className={
                        index === 0 ? "search-result is-first" : "search-result"
                      }
                      type="button"
                      key={commit.hash}
                      onClick={() => selectCommit(commit)}
                    >
                      <span>{commit.shortHash}</span>
                      <strong>{commit.subject}</strong>
                      <small>{commit.author}</small>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  ))
                ) : (
                  <p className="search-empty">No commits found.</p>
                )}
              </div>
              <footer className="search-footer">
                <span>{searchResults.length} results</span>
                <span>Esc to close</span>
              </footer>
            </section>
          </div>
        ) : null}

        {proposalOpen ? (
          <div
            className="overlay"
            role="presentation"
            onMouseDown={() => setProposalOpen(false)}
          >
            <section
              className="proposal-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="proposal-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                className="dialog-close"
                type="button"
                onClick={() => setProposalOpen(false)}
              >
                <X aria-hidden="true" /> <span className="sr-only">Close</span>
              </button>
              <p className="eyebrow">MPP proposal gate · testnet preview</p>
              <h2 id="proposal-title">Propose a change</h2>
              {!snapshot ? repositoryLoadError ? (
                <p className="proposal-intro">
                  The thread repository is unavailable. Return to the agent workspace and retry the pull.
                </p>
              ) : null : !selected ? (
                <p className="proposal-intro">
                  Commit and push the thread workspace before proposing a change.
                </p>
              ) : proposalState === "payment-required" ? (
                <div className="payment-required">
                  <div className="payment-mark">402</div>
                  <h3>Payment challenge ready</h3>
                  <p>
                    The Worker returned the preview MPP challenge. No funds
                    moved; a live recipient and settlement policy still need to
                    be configured.
                  </p>
                  <button
                    className="button button--high"
                    type="button"
                    onClick={() => setProposalOpen(false)}
                  >
                    Done
                  </button>
                </div>
              ) : (
                <>
                  <p className="proposal-intro">
                    Submit a patch against <strong>{selected.shortHash}</strong>
                    . The $0.20 proposal fee is a rate limit, not access to the
                    repository.
                  </p>
                  <label>
                    Proposal title
                    <input
                      value={proposalTitle}
                      onChange={(event) => setProposalTitle(event.target.value)}
                      placeholder="What should change?"
                    />
                  </label>
                  <div className="proposal-summary">
                    <div>
                      <span>Repository</span>
                      <strong>nanocodex</strong>
                    </div>
                    <div>
                      <span>Base</span>
                      <strong>{selected.shortHash}</strong>
                    </div>
                    <div>
                      <span>Preview fee</span>
                      <strong>$0.20</strong>
                    </div>
                  </div>
                  <button
                    className="button button--high proposal-submit"
                    type="button"
                    disabled={proposalState === "submitting"}
                    onClick={submitProposal}
                  >
                    {proposalState === "submitting"
                      ? "Requesting challenge…"
                      : "Continue to payment"}
                    <ArrowUpRight aria-hidden="true" />
                  </button>
                </>
              )}
            </section>
          </div>
        ) : null}
    </div>
  );
}
