import pierreDark from "@pierre/theme/pierre-dark-soft";
import pierreLight from "@pierre/theme/pierre-light";
import {
  type CodeViewItem,
  type CodeViewOptions,
  type SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import {
  prepareFileTreeInput,
  themeToTreeStyles,
  type FileTreePreparedInput,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { ChevronRight, FileQuestion, GitBranch, PanelLeft, RefreshCw, Search, X } from "lucide-react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { usePierreRenderer } from "./PierreWorkerProvider";
import {
  CODE_VIEW_CUSTOM_CSS,
  CODE_VIEW_LAYOUT,
  CODE_VIEW_THEMES,
  COMPACT_WORKSPACE_QUERY,
  getInitialBatchSize,
  observePierreCodeScrollRegions,
} from "./pierreCodeView";
import { syntaxLanguageForFile } from "./syntax";
import type { RepositoryFile } from "./threadRepositorySnapshot";
import "./SourceBrowser.css";

type CodeBrowserProps = {
  files: RepositoryFile[];
  branch: string;
  head: string;
  readFile(file: RepositoryFile): Promise<string>;
  theme: "light" | "dark";
};

export type CodeBrowserHandle = {
  closeSearches(): void;
  openFileSearch(): void;
  openTreeSearch(): void;
};

export type SourceLineRange = {
  start: number;
  end: number;
};

type SourceFileError = {
  file: RepositoryFile;
  kind: "request" | "unsupported";
};

type SourceLocation = {
  path: string;
  range: SourceLineRange | null;
};

type CodeViewSelection = {
  id: string;
  range: SelectedLineRange;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function formatBytes(value: number | null) {
  if (value === null) return "—";
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function countLines(contents: string | null): number | null {
  if (contents === null) return null;
  if (!contents) return 0;
  let lines = 1;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export function parseSourceLineHash(hash: string): SourceLineRange | null {
  const match = /^#L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(hash);
  if (!match) return null;
  const first = Number(match[1]);
  const second = match[2] ? Number(match[2]) : first;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) return null;
  return {
    start: Math.min(first, second),
    end: Math.max(first, second),
  };
}

export function classifySourceFileError(error: unknown): SourceFileError["kind"] {
  const message = error instanceof Error ? error.message : String(error);
  return /not (?:a text file|available as published text)|binary|unsupported/i.test(message)
    ? "unsupported"
    : "request";
}

function readSourceLocation(
  filePaths: ReadonlySet<string>,
  defaultPath: string,
  search: string,
  hash: string,
): SourceLocation {
  const requestedPath = new URLSearchParams(search).get("path");
  const validPath = requestedPath == null || filePaths.has(requestedPath);
  return {
    path: requestedPath != null && validPath
      ? requestedPath
      : defaultPath,
    range: validPath ? parseSourceLineHash(hash) : null,
  };
}

function normalizeLineRange(
  range: SourceLineRange,
  totalLines: number | null,
): SourceLineRange | null {
  if (totalLines === 0) return null;
  const maximum = totalLines == null ? Number.MAX_SAFE_INTEGER : Math.max(1, totalLines);
  const start = Math.max(1, Math.min(maximum, range.start));
  const end = Math.max(start, Math.min(maximum, range.end));
  return { start, end };
}

function currentCompactWorkspace(): boolean {
  return typeof window !== "undefined" && window.matchMedia(COMPACT_WORKSPACE_QUERY).matches;
}

function useCompactWorkspace(): boolean {
  const [compact, setCompact] = useState(currentCompactWorkspace);
  useEffect(() => {
    const media = window.matchMedia(COMPACT_WORKSPACE_QUERY);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}

function deepActiveElement(root: Document | ShadowRoot): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function isWithinDeepRoot(container: Element, element: Element | null): boolean {
  let current = element;
  while (current) {
    if (container.contains(current)) return true;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

function focusableElements(root: Document | ShadowRoot | HTMLElement): HTMLElement[] {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  for (const host of root.querySelectorAll<HTMLElement>("*")) {
    if (host.shadowRoot) elements.push(...focusableElements(host.shadowRoot));
  }
  return elements;
}

function CodeBrowserComponent(
  { files, branch, head, readFile, theme }: CodeBrowserProps,
  ref: ForwardedRef<CodeBrowserHandle>,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const defaultPath = useMemo(
    () =>
      files.find((file) => file.path === "src/main.rs")?.path ??
      files.find((file) => file.path === "README.md")?.path ??
      files[0]?.path ??
      "",
    [files],
  );
  const fileByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  const filePaths = useMemo(() => new Set(fileByPath.keys()), [fileByPath]);
  const initialLocation = useMemo(
    () => readSourceLocation(filePaths, defaultPath, location.search, location.hash),
    [defaultPath, filePaths, location.hash, location.search],
  );
  const [selectedPath, setSelectedPath] = useState(initialLocation.path);
  const [lineTarget, setLineTarget] = useState<SourceLineRange | null>(initialLocation.range);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const readFileRef = useRef(readFile);
  readFileRef.current = readFile;
  const [loaded, setLoaded] = useState<{
    contents: string;
    file: RepositoryFile;
  } | null>(null);
  const [fileError, setFileError] = useState<SourceFileError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [treeOpen, setTreeOpen] = useState(false);
  const compact = useCompactWorkspace();
  const treePanelRef = useRef<HTMLDivElement>(null);
  const treeCloseRef = useRef<HTMLButtonElement>(null);
  const treeOpenerRef = useRef<HTMLButtonElement>(null);
  const codeViewContainerRef = useRef<HTMLDivElement>(null);
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const suppressTreeSelectionRef = useRef(false);
  const renderer = usePierreRenderer();
  const initialVisibleRowCount = useMemo(getInitialBatchSize, []);
  const treeInput = useMemo(
    () => prepareFileTreeInput(files.map((file) => file.path), {
      flattenEmptyDirectories: true,
    }),
    [files],
  );
  const { model } = useFileTree({
    preparedInput: treeInput as unknown as FileTreePreparedInput,
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    initialSelectedPaths: initialLocation.path ? [initialLocation.path] : [],
    initialSearchQuery: null,
    fileTreeSearchMode: "hide-non-matches",
    search: true,
    searchBlurBehavior: "close",
    stickyFolders: true,
    density: "compact",
    icons: { set: "standard", colored: false },
    initialVisibleRowCount,
    overscan: 10,
  });
  const selected = fileByPath.get(selectedPath) ?? files[0];
  const displayed = loaded?.file;
  const contents = loaded?.contents ?? null;
  const viewFile = displayed ?? selected;
  const codeReady = loaded != null && renderer.ready;
  const lineCount = useMemo(() => countLines(contents), [contents]);
  const normalizedLineTarget = useMemo(
    () => lineTarget == null ? null : normalizeLineRange(lineTarget, lineCount),
    [lineCount, lineTarget],
  );
  const codeItemId = loaded ? `file:${loaded.file.objectId}` : "";
  const selectedLines = useMemo<CodeViewSelection | null>(
    () => codeReady && loaded?.file.path === selectedPath && normalizedLineTarget
      ? {
          id: codeItemId,
          range: {
            start: normalizedLineTarget.start,
            end: normalizedLineTarget.end,
          },
        }
      : null,
    [codeItemId, codeReady, loaded?.file.path, normalizedLineTarget, selectedPath],
  );
  const treeTheme = useMemo(
    () => themeToTreeStyles(theme === "dark" ? pierreDark : pierreLight) as CSSProperties,
    [theme],
  );
  const locationRef = useRef(location);
  locationRef.current = location;
  const writeSourceLocation = useCallback((
    path: string,
    range: SourceLineRange | null,
    mode: "push" | "replace",
  ) => {
    const current = locationRef.current;
    const search = new URLSearchParams(current.search);
    if (path) search.set("path", path);
    else search.delete("path");
    const encodedSearch = search.toString();
    const hash = range == null
      ? ""
      : range.start === range.end
        ? `#L${range.start}`
        : `#L${range.start}-L${range.end}`;
    void navigate({
      pathname: current.pathname,
      search: encodedSearch ? `?${encodedSearch}` : "",
      hash,
    }, {
      replace: mode === "replace",
      preventScrollReset: true,
    });
  }, [navigate]);

  const closeTree = useCallback(() => {
    model.closeSearch();
    setTreeOpen(false);
  }, [model]);

  const openTreeSearch = useCallback(() => {
    if (compact) setTreeOpen(true);
    model.openSearch();
  }, [compact, model]);

  const closeSearches = useCallback(() => {
    model.closeSearch();
    setTreeOpen(false);
  }, [model]);

  useImperativeHandle(
    ref,
    () => ({
      closeSearches,
      // Compatibility for the shell's existing handle; Source now has one search.
      openFileSearch: openTreeSearch,
      openTreeSearch,
    }),
    [closeSearches, openTreeSearch],
  );

  const syncTreeSelection = useCallback((path: string) => {
    suppressTreeSelectionRef.current = true;
    try {
      for (const selectedFile of model.getSelectedPaths()) {
        if (selectedFile !== path) model.getItem(selectedFile)?.deselect();
      }
      model.getItem(path)?.select();
      model.focusPath(path);
      model.scrollToPath(path, { offset: "center" });
    } finally {
      suppressTreeSelectionRef.current = false;
    }
  }, [model]);

  useEffect(() => {
    const requestedPath = new URLSearchParams(location.search).get("path");
    const next = readSourceLocation(
      filePaths,
      defaultPath,
      location.search,
      location.hash,
    );
    selectedPathRef.current = next.path;
    setSelectedPath(next.path);
    setLineTarget(next.range);
    setFileError(null);
    if (next.path) syncTreeSelection(next.path);
    closeTree();
    if (requestedPath != null && !filePaths.has(requestedPath) && defaultPath) {
      writeSourceLocation(defaultPath, null, "replace");
    }
  }, [
    closeTree,
    defaultPath,
    filePaths,
    location.hash,
    location.search,
    syncTreeSelection,
    writeSourceLocation,
  ]);

  useEffect(() => {
    return model.subscribe(() => {
      if (suppressTreeSelectionRef.current) return;
      const nextPath = model
        .getSelectedPaths()
        .slice()
        .reverse()
        .find((path) => fileByPath.has(path));
      if (!nextPath || nextPath === selectedPathRef.current) return;
      selectedPathRef.current = nextPath;
      setSelectedPath(nextPath);
      setLineTarget(null);
      setFileError(null);
      writeSourceLocation(nextPath, null, "push");
      closeTree();
    });
  }, [closeTree, fileByPath, model, writeSourceLocation]);

  useEffect(() => {
    if (!selected) {
      setFileError(null);
      return;
    }
    let active = true;
    setFileError(null);
    readFileRef.current(selected)
      .then((nextContents) => {
        if (!active) return;
        setLoaded({ contents: nextContents, file: selected });
        setFileError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFileError({ file: selected, kind: classifySourceFileError(error) });
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, selected?.objectId, selected?.path]);

  const applyLineTarget = useCallback(() => {
    if (!selectedLines) return;
    codeViewRef.current?.scrollTo({
      type: "range",
      id: selectedLines.id,
      range: selectedLines.range,
      align: "center",
      behavior: "instant",
    });
  }, [selectedLines]);

  useEffect(() => {
    applyLineTarget();
  }, [applyLineTarget]);

  useEffect(() => {
    const container = codeViewContainerRef.current;
    if (!container || !viewFile || !codeReady) return;
    container.tabIndex = 0;
    container.setAttribute("role", "region");
    container.setAttribute("aria-label", `${viewFile.path} source code`);
    return observePierreCodeScrollRegions(container, applyLineTarget);
  }, [applyLineTarget, codeReady, viewFile]);

  useEffect(() => {
    const panel = treePanelRef.current;
    if (!panel) return;
    let frame: number | undefined;
    let stopped = false;

    const exposeVirtualizedRows = (): boolean => {
      const shadowRoot = panel.querySelector("file-tree-container")?.shadowRoot;
      const root = shadowRoot?.querySelector<HTMLElement>(
        "[data-file-tree-virtualized-root]",
      );
      const rows = root?.querySelector<HTMLElement>(
        "[data-file-tree-virtualized-scroll]",
      );
      if (!root || !rows) return false;

      if (root.hasAttribute("role")) root.removeAttribute("role");
      if (root.hasAttribute("aria-label")) root.removeAttribute("aria-label");
      if (rows.getAttribute("role") !== "tree") rows.setAttribute("role", "tree");
      if (rows.getAttribute("aria-label") !== "Repository files") {
        rows.setAttribute("aria-label", "Repository files");
      }
      const rowsId = `${root.id || "repository-file-tree"}__rows`;
      if (rows.id !== rowsId) rows.id = rowsId;
      const searchInput = root.querySelector<HTMLInputElement>(
        "[data-file-tree-search-input]",
      );
      if (searchInput?.getAttribute("aria-controls") !== rowsId) {
        searchInput?.setAttribute("aria-controls", rowsId);
      }
      return true;
    };

    const attach = () => {
      if (stopped) return;
      if (exposeVirtualizedRows()) return;
      frame = window.requestAnimationFrame(attach);
    };

    attach();
    return () => {
      stopped = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [model]);

  useEffect(() => {
    if (!treeOpen || !compact) return;
    const root = window.document.documentElement;
    const body = window.document.body;
    const previousRootOverflow = root.style.overflow;
    const previousRootOverscroll = root.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";

    model.openSearch();
    const focusFrame = window.requestAnimationFrame(() => {
      if (!treePanelRef.current || !isWithinDeepRoot(
        treePanelRef.current,
        deepActiveElement(window.document),
      )) {
        treeCloseRef.current?.focus();
      }
    });
    const containDrawerFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTree();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = treePanelRef.current;
      if (!panel) return;
      const focusable = focusableElements(panel);
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = deepActiveElement(window.document);
      if (!first || !last) return;
      if (event.shiftKey && (active === first || !isWithinDeepRoot(panel, active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !isWithinDeepRoot(panel, active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", containDrawerFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", containDrawerFocus);
      root.style.overflow = previousRootOverflow;
      root.style.overscrollBehavior = previousRootOverscroll;
      body.style.overflow = previousBodyOverflow;
      treeOpenerRef.current?.focus();
    };
  }, [closeTree, compact, model, treeOpen]);

  useEffect(() => {
    if (!compact && treeOpen) closeTree();
  }, [closeTree, compact, treeOpen]);

  const codeItems = useMemo<CodeViewItem<undefined>[]>(
    () =>
      codeReady && loaded
        ? [
            {
              id: codeItemId,
              type: "file",
              file: {
                name: loaded.file.path,
                contents: loaded.contents,
                cacheKey: loaded.file.objectId,
                lang: syntaxLanguageForFile(loaded.file.path, loaded.contents),
              },
            },
          ]
        : [],
    [codeItemId, codeReady, loaded],
  );
  const codeViewOptions = useMemo<CodeViewOptions<undefined>>(
    () => ({
      layout: CODE_VIEW_LAYOUT,
      theme: CODE_VIEW_THEMES,
      themeType: theme,
      overflow: "scroll",
      disableFileHeader: true,
      lineHoverHighlight: "number",
      enableLineSelection: true,
      stickyHeaders: true,
      unsafeCSS: CODE_VIEW_CUSTOM_CSS,
    }),
    [theme],
  );

  const handleSelectedLinesChange = useCallback((selection: CodeViewSelection | null) => {
    if (!loaded || loaded.file.path !== selectedPathRef.current) return;
    const next = selection == null
      ? null
      : normalizeLineRange({
          start: selection.range.start,
          end: selection.range.end,
        }, lineCount);
    setLineTarget(next);
    writeSourceLocation(loaded.file.path, next, "replace");
  }, [lineCount, loaded, writeSourceLocation]);

  const modalOpen = compact && treeOpen;
  const errorCopy = fileError?.kind === "unsupported"
    ? `${fileError.file.path} is not available as text.`
    : fileError
      ? `Couldn’t load ${fileError.file.path}.`
      : "";

  return (
    <section className="code-workspace source-browser" aria-label="Code browser">
      <h1 className="sr-only">Nanocodex source code</h1>
      <div
        className={modalOpen ? "workspace-backdrop is-visible" : "workspace-backdrop"}
        aria-hidden="true"
        onPointerDown={closeTree}
      />
      <div
        ref={treePanelRef}
        id="source-file-tree"
        className={modalOpen ? "code-tree-panel is-mobile-open" : "code-tree-panel"}
        aria-labelledby="source-tree-title"
        role={modalOpen ? "dialog" : "complementary"}
        aria-modal={modalOpen ? true : undefined}
      >
        <header className="pierre-tree-heading source-tree-toolbar">
          <div className="source-tree-identity">
            <strong id="source-tree-title">Files</strong>
            <span>
              <GitBranch aria-hidden="true" /> {branch} · {head.slice(0, 7)}
            </span>
          </div>
          <div className="source-tree-actions">
            <span className="source-file-count">{files.length}</span>
            <button
              className="tree-search-trigger"
              type="button"
              onClick={openTreeSearch}
              aria-label="Search repository files"
              aria-keyshortcuts="Meta+P Control+P"
            >
              <Search aria-hidden="true" />
              <kbd>⌘/Ctrl P</kbd>
            </button>
            <button
              ref={treeCloseRef}
              className="tree-close-button"
              type="button"
              onClick={closeTree}
              aria-label="Close file tree"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>
        <FileTree
          className="pierre-file-tree"
          model={model}
          style={treeTheme}
        />
      </div>

      <article
        className="code-file"
        aria-label={viewFile?.path ?? "File viewer"}
        inert={modalOpen ? true : undefined}
      >
        {viewFile ? (
          <>
            <header className="code-file-header">
              <button
                ref={treeOpenerRef}
                className="mobile-tree-toggle"
                type="button"
                onClick={openTreeSearch}
                aria-label="Open file tree and search files"
                aria-controls="source-file-tree"
                aria-expanded={modalOpen}
              >
                <PanelLeft aria-hidden="true" />
              </button>
              <div
                className="file-breadcrumb"
                role="group"
                aria-label={`File path: ${viewFile.path}`}
              >
                {viewFile.path.split("/").map((part, index, parts) => (
                  <span key={`${part}-${index}`}>
                    {part}
                    {index < parts.length - 1 ? <ChevronRight aria-hidden="true" /> : null}
                  </span>
                ))}
              </div>
              <div className="code-file-meta">
                <span>{formatBytes(viewFile.size)}</span>
                {lineCount !== null ? <span>{lineCount} lines</span> : null}
              </div>
            </header>
            {fileError && loaded ? (
              <div className="code-file-tail-error" role="alert">
                <span>{errorCopy}</span>
                {fileError.kind === "request" ? (
                  <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                    <RefreshCw aria-hidden="true" /> Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            {codeReady ? (
              <CodeView
                ref={codeViewRef}
                key={renderer.disableWorkerPool ? "main" : "workers"}
                items={codeItems}
                className="code-file-frame code-view cv-scrollbar"
                containerRef={codeViewContainerRef}
                disableWorkerPool={renderer.disableWorkerPool}
                options={codeViewOptions}
                selectedLines={selectedLines}
                onSelectedLinesChange={handleSelectedLinesChange}
              />
            ) : fileError ? (
              <div className="code-file-frame">
                <div className="code-file-message" role="alert">
                  <FileQuestion aria-hidden="true" />
                  <p>{errorCopy}</p>
                  {fileError.kind === "request" ? (
                    <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                      <RefreshCw aria-hidden="true" /> Retry
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="code-file-message">This snapshot has no files.</div>
        )}
      </article>
    </section>
  );
}

export const CodeBrowser = memo(forwardRef(CodeBrowserComponent));
