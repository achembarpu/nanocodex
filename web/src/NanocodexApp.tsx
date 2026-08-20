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

const installCommand = "cargo add nanocodex";

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
                  <h1 id="home-title">The coding agent is the library.</h1>
                  <button
                    className="home-install"
                    type="button"
                    aria-label="Copy Rust install command"
                    onClick={() => {
                      void navigator.clipboard.writeText(installCommand).then(() => {
                        setInstallCopied(true);
                        window.setTimeout(() => setInstallCopied(false), 1_500);
                      });
                    }}
                  >
                    <span aria-hidden="true">$</span>
                    <code>{installCommand}</code>
                    <span className="home-install-state">
                      {installCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      {installCopied ? "copied" : "copy"}
                    </span>
                  </button>
                  <p className="home-meta">Rust · JavaScript · Python · native + WebAssembly</p>
                </header>

                <section className="home-demo" id="agent-demo" aria-labelledby="agent-demo-title">
                  <h2 className="sr-only" id="agent-demo-title">Live Nanocodex browser agent</h2>
                  <Suspense fallback={null}>
                    <AgentTerminal />
                  </Suspense>
                </section>

                <section className="home-summary" aria-label="What Nanocodex is">
                  <p>
                    Nanocodex is a headless Rust agents SDK. It owns the coding
                    loop—sessions, typed history, tools, retries, branches,
                    cancellation, and cleanup—while your application owns the
                    interface and policy.
                  </p>
                  <p>
                    One retained session reuses its WebSocket, history, tools,
                    shell, and cache identity. Send a prompt, await a typed
                    result, or consume the same event stream independently.
                  </p>
                  <p>
                    JavaScript can run that loop directly in a browser Worker
                    with OPFS, shell, Python, Git, patches, datasets, search,
                    image generation, and live React artifacts. Use a VM or
                    hosted sandbox only when you need an isolation boundary.
                  </p>
                  <p>
                    <a href="https://github.com/clabby/tact" target="_blank" rel="noreferrer">Tact</a>
                    {" "}shows the intended composition: Nanocodex supplies the
                    agent lifecycle; the product supplies its terminal, review,
                    skills, authorization, durable index, and memory system.
                  </p>
                  <nav className="home-links" aria-label="Nanocodex links">
                    <a href="/docs">docs</a>
                    <a href="/docs/sdks/javascript">JavaScript</a>
                    <a href="/docs/sdks/python">Python</a>
                    <a href="/docs/examples/tact">Tact case study</a>
                    <a href="https://github.com/gakonst/nanocodex" target="_blank" rel="noreferrer">source</a>
                  </nav>
                </section>

                <p className="home-divider" aria-hidden="true">***</p>

                <section className="home-facts" aria-label="Nanocodex capabilities">
                  <article>
                    <h2>Owned agent lifecycle</h2>
                    <p>Prompt ordering, independently awaitable turns, committed history, reconnect replay, compaction, snapshots, branches, and process-group cleanup.</p>
                  </article>
                  <article>
                    <h2>Tools and Code Mode</h2>
                    <p>Caller-defined typed tools, heterogeneous registries, MCP transports, deferred discovery, remote dispatch, and one agent-owned execution loop.</p>
                  </article>
                  <article>
                    <h2>Native and browser hosts</h2>
                    <p>Run in Rust, Node, Python, browser WASM, Cloudflare Workers, Vercel Workflows, or an application-owned VM without changing the session contract.</p>
                  </article>
                  <article>
                    <h2>Bring any interface</h2>
                    <p>Attach one retained agent to xterm.js, WTerm, a native TTY, WebSocket, or test through a five-method terminal host—or consume typed events directly in React, storage, and telemetry.</p>
                  </article>
                  <article>
                    <h2>Application-owned memory</h2>
                    <p>Memory is explicit product policy, not hidden context injection. Tact demonstrates versioned keys, scan-before-put behavior, and root-write/child-read authority.</p>
                  </article>
                  <article>
                    <h2>Verifier-backed evals</h2>
                    <p>39/39 latency gates, 0.267 ms median local overhead, and a retained 13/20 Terminal-Bench slice—with trajectories, verifier output, usage, and artifacts.</p>
                    <a href={threadSurfacePath("evals")} onFocus={preloadEvalOverview} onPointerEnter={preloadEvalOverview} onClick={(event) => { event.preventDefault(); navigateToSurface("evals"); }}>inspect live evals</a>
                  </article>
                </section>

                <section className="home-start" aria-label="Install Nanocodex">
                  <code>$ cargo add nanocodex</code>
                  <code>$ npm install nanocodex</code>
                  <code>$ npm install nanocodex-terminal @xterm/xterm</code>
                  <nav>
                    <a href="/docs/getting-started">get started</a>
                    <a href="https://github.com/gakonst/nanocodex/tree/master/examples/vercel-workflows" target="_blank" rel="noreferrer">wterm example</a>
                    <a href="https://github.com/gakonst/nanocodex/releases/latest" target="_blank" rel="noreferrer">releases</a>
                  </nav>
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
