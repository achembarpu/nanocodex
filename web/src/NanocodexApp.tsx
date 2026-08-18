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
import { fuzzyScore } from "./fuzzy";
import { pathForSurface, surfaceFromUrl, type Surface } from "./navigation";
import type { HarnessCommit, RepositorySnapshot } from "./threadRepositorySnapshot";
import { getBrowserThread } from "./workspace";

const Evals = lazy(() =>
  import("./Evals").then((module) => ({ default: module.Evals }))
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

function loadRepositorySnapshot(): Promise<RepositorySnapshot> {
  return import("./threadRepositorySnapshot")
    .then((module) => module.loadThreadRepositorySnapshot());
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

function RepositorySurfaceLoading({ failed }: { failed: boolean }) {
  if (!failed) return null;
  return (
    <section className="requests-empty page-grid" aria-live="polite">
      <GitBranch aria-hidden="true" />
      <p className="eyebrow">Repository</p>
      <h1>Thread repository unavailable.</h1>
      <p>Return to the agent workspace and retry the thread pull.</p>
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
  const thread = useMemo(getBrowserThread, []);
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
  const [snapshot, setSnapshot] = useState<RepositorySnapshot>();
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const headerCenterRef = useRef<HTMLDivElement>(null);
  const codeBrowserRef = useRef<CodeBrowserHandle>(null);
  const commitStreamRef = useRef<CommitCodeStreamHandle>(null);
  const snapshotRef = useRef<RepositorySnapshot | undefined>(undefined);
  const repositoryRequestId = useRef(0);
  snapshotRef.current = snapshot;

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
    const requestId = ++repositoryRequestId.current;
    setRepositoryLoadError(false);
    void loadRepositorySnapshot().then(
      (loaded) => {
        if (repositoryRequestId.current !== requestId) {
          loaded.release();
          return;
        }
        setSnapshot((current) => {
          current?.release();
          return loaded;
        });
        setSelectedHash((current) => current && loaded.commits.some(({ hash }) => hash === current)
          ? current
          : loaded.repository.head);
      },
      () => {
        if (repositoryRequestId.current === requestId) setRepositoryLoadError(true);
      },
    );
  }, []);

  useEffect(() => {
    const needsRepository =
      surface === "code" || surface === "commits" || proposalOpen;
    if (needsRepository && !snapshot) refreshRepository();
  }, [proposalOpen, refreshRepository, snapshot, surface]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;
    void import("./threadGit").then(({ subscribeThreadGitChanges }) => {
      if (!active) return;
      unsubscribe = subscribeThreadGitChanges(thread, () => {
        if (snapshotRef.current) refreshRepository();
      });
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [refreshRepository, thread]);

  useEffect(() => () => {
    repositoryRequestId.current++;
    snapshotRef.current?.release();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#161616" : "#ffffff");
    localStorage.setItem("nanocodex-theme", theme);
  }, [theme]);

  const threadSurfacePath = useCallback(
    (nextSurface: Surface) => `${pathForSurface(nextSurface)}?thread=${thread.id}`,
    [thread.id],
  );
  const navigateToSurface = useCallback((nextSurface: Surface) => {
    navigate(threadSurfacePath(nextSurface));
  }, [navigate, threadSurfacePath]);

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
            <nav className="surface-switch" aria-label="Repository surfaces">
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
                onClick={(event) => {
                  event.preventDefault();
                  navigateToSurface("evals");
                }}
              >
                Evals <span>[E]</span>
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
            <section className="home-page" aria-labelledby="home-title">
                <article className="home-article">
                  <header className="home-intro">
                    <h1 id="home-title">
                      Nanocodex: a headless Codex runtime you can embed.
                    </h1>
                    <p>
                      Nanocodex packages Codex lifecycle and context management
                      behind an ergonomic Rust API, so you can bring the agent
                      loop into your own applications without bringing along an
                      entire product.
                    </p>
                  </header>

                  <Suspense
                    fallback={
                      <section
                        className="agent-tui agent-tui-loading"
                        aria-label="Nanocodex terminal"
                        aria-busy="true"
                      >
                        Loading agent…
                      </section>
                    }
                  >
                    <AgentTerminal />
                  </Suspense>

                  <section
                    className="home-release-section"
                    aria-labelledby="home-release-title"
                  >
                    <div className="home-release-heading">
                      <div>
                        <p className="eyebrow">Install the CLI</p>
                        <h2 id="home-release-title">One binary. Kept current.</h2>
                      </div>
                      <a
                        href="https://github.com/gakonst/nanocodex/releases/latest"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Latest release <ArrowUpRight aria-hidden="true" />
                      </a>
                    </div>
                    <div className="home-install-command">
                      <code>{installCommand}</code>
                      <button
                        type="button"
                        aria-label="Copy install command"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(installCommand)
                            .then(() => {
                              setInstallCopied(true);
                              window.setTimeout(
                                () => setInstallCopied(false),
                                1_500
                              );
                            });
                        }}
                      >
                        {installCopied ? (
                          <Check aria-hidden="true" />
                        ) : (
                          <Copy aria-hidden="true" />
                        )}
                        {installCopied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <div className="home-release-grid">
                      <article>
                        <span>Update</span>
                        <code>nanocodex update</code>
                        <p>
                          Downloads the host binary, verifies its SHA-256, and
                          replaces the current executable.
                        </p>
                      </article>
                      <article>
                        <span>Embed</span>
                        <code>cargo add nanocodex</code>
                        <p>
                          All seven public Rust crates ship together under one
                          version in dependency order.
                        </p>
                      </article>
                      <article>
                        <span>Inspect</span>
                        <a href="https://github.com/gakonst/nanocodex/blob/master/CHANGELOG.md">
                          Release changelog <ArrowUpRight aria-hidden="true" />
                        </a>
                        <p>
                          Conventional commits are grouped in full; GitHub
                          release notes credit every pull request contributor.
                        </p>
                      </article>
                    </div>
                  </section>

                  <div className="home-copy">
                    <section>
                      <h2>A library, not a product</h2>
                      <ul>
                        <li>
                          Codex is a complete coding agent. Nanocodex isolates
                          the reusable engine: model lifecycle, conversation
                          context &amp; the exact tool boundary.
                        </li>
                        <li>
                          The core intentionally does not ship subagents, skills
                          or on-disk history. Your application owns orchestration,
                          persistence &amp; product policy.
                        </li>
                        <li>
                          The library-first architecture is designed for native
                          Rust applications, WebAssembly in the browser &amp;
                          Python bindings through PyO3.
                        </li>
                      </ul>
                    </section>

                    <section>
                      <h2>What we optimize for</h2>
                      <ul>
                        <li>
                          Production-grade Rust patterns. Tower middleware keeps
                          cross-cutting behavior composable &amp; application-specific
                          extensions straightforward.
                        </li>
                        <li>
                          Conversation forks as a first-class primitive, so
                          branching from shared context is fast &amp; efficient.
                        </li>
                        <li>
                          Eval-driven development. Every vertical slice runs on
                          real tasks, with failures traced through the verifier
                          &amp; complete tool trajectory.
                        </li>
                      </ul>
                    </section>
                  </div>

                </article>
            </section>
          ) : surface === "code" ? snapshot ? (
            <Suspense fallback={null}>
              <PierreWorkerProvider>
                  <CodeBrowser
                    key={snapshot.repository.head}
                    ref={codeBrowserRef}
                    files={snapshot.tree}
                    branch={snapshot.repository.branch}
                  head={snapshot.repository.head}
                  theme={theme}
                />
              </PierreWorkerProvider>
            </Suspense>
          ) : (
            <RepositorySurfaceLoading failed={repositoryLoadError} />
          ) : surface === "commits" ? snapshot ? (
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

                  <Suspense fallback={<div className="commit-list" />}>
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
            <RepositorySurfaceLoading failed={repositoryLoadError} />
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
            <Suspense fallback={<section className="eval-surface-loading" aria-busy="true">Loading evals…</section>}>
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
