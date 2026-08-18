import {
  DEFAULT_THEMES,
  type CodeViewItem,
  type CodeViewOptions,
} from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { prepareFileTreeInput, type FileTreePreparedInput } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { ChevronRight, FileQuestion, GitBranch, PanelLeft, Search, X } from "lucide-react";
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
} from "react";
import { fuzzyScore } from "./fuzzy";
import { usePierreRenderer } from "./PierreWorkerProvider";
import { CODE_VIEW_CUSTOM_CSS, CODE_VIEW_LAYOUT } from "./pierreCodeView";
import { syntaxLanguageForFile } from "./syntax";

export type RepositoryFile = {
  path: string;
  mode: string;
  objectId: string;
  size: number | null;
  contentUrl: string | null;
};

type CodeBrowserProps = {
  files: RepositoryFile[];
  branch: string;
  head: string;
  theme: "light" | "dark";
};

export type CodeBrowserHandle = {
  closeSearches(): void;
  openFileSearch(): void;
  openTreeSearch(): void;
};

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

function CodeBrowserComponent(
  { files, branch, head, theme }: CodeBrowserProps,
  ref: ForwardedRef<CodeBrowserHandle>,
) {
  const defaultPath = useMemo(
    () =>
      files.find((file) => file.path === "src/main.rs")?.path ??
      files.find((file) => file.path === "README.md")?.path ??
      files[0]?.path ??
      "",
    [files],
  );
  const [selectedPath, setSelectedPath] = useState(defaultPath);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const [contents, setContents] = useState<string | null>(null);
  const [loadedObjectId, setLoadedObjectId] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);
  const renderer = usePierreRenderer();
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
    initialSelectedPaths: defaultPath ? [defaultPath] : [],
    initialSearchQuery: null,
    fileTreeSearchMode: "hide-non-matches",
    search: true,
    searchBlurBehavior: "close",
    stickyFolders: true,
    density: "compact",
    icons: { set: "standard", colored: false },
  });
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const displayed = loadedObjectId == null
    ? undefined
    : files.find((file) => file.objectId === loadedObjectId);
  const viewFile = displayed ?? selected;
  const codeReady =
    displayed != null &&
    contents !== null &&
    renderer.ready;
  const fileSearchResults = useMemo(() => {
    const tokens = fileQuery.trim().split(/\s+/).filter(Boolean);
    const matches = files
      .map((file) => {
        const basename = file.path.split("/").at(-1) ?? file.path;
        let score = 0;
        for (const token of tokens) {
          const pathScore = fuzzyScore(file.path, token);
          const basenameScore = fuzzyScore(basename, token);
          const best = Math.max(pathScore ?? -Infinity, (basenameScore ?? -Infinity) + 80);
          if (!Number.isFinite(best)) return null;
          score += best;
        }
        if (file.path === selectedPath) score += tokens.length ? 15 : 1_000;
        return { file, score };
      })
      .filter((match): match is { file: RepositoryFile; score: number } => match !== null)
      .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
    return matches.slice(0, 16);
  }, [fileQuery, files, selectedPath]);

  const openTreeSearch = () => {
    setFileSearchOpen(false);
    setTreeOpen(true);
    model.openSearch();
  };

  const openFileSearch = () => {
    model.closeSearch();
    setFileQuery("");
    setActiveFileIndex(0);
    setFileSearchOpen(true);
  };

  const closeSearches = () => {
    model.closeSearch();
    setFileSearchOpen(false);
    setTreeOpen(false);
  };

  useImperativeHandle(
    ref,
    () => ({ closeSearches, openFileSearch, openTreeSearch }),
    [model],
  );

  const selectFile = (path: string) => {
    selectedPathRef.current = path;
    model.closeSearch();
    for (const selectedFile of model.getSelectedPaths()) {
      if (selectedFile !== path) model.getItem(selectedFile)?.deselect();
    }
    model.getItem(path)?.select();
    model.focusPath(path);
    model.scrollToPath(path, { offset: "center" });
    setSelectedPath(path);
    setFileSearchOpen(false);
    setFileQuery("");
    setTreeOpen(false);
  };
  const treeHeader = useMemo(
    () => (
      <div className="pierre-tree-heading">
        <div>
          <strong>Files</strong>
          <span>
            <GitBranch aria-hidden="true" /> {branch} · {head.slice(0, 7)}
          </span>
        </div>
        <div>
          <span>{files.length}</span>
          <button
            className="tree-search-trigger"
            type="button"
            onClick={openTreeSearch}
            aria-label="Search files in tree"
          >
            <Search aria-hidden="true" />
            <kbd>Ctrl P</kbd>
          </button>
          <button
            className="tree-close-button"
            type="button"
            onClick={() => setTreeOpen(false)}
            aria-label="Close file tree"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </div>
    ),
    [branch, files.length, head, model],
  );

  useEffect(() => {
    if (fileSearchOpen) requestAnimationFrame(() => fileSearchInputRef.current?.focus());
  }, [fileSearchOpen]);

  useEffect(() => {
    setActiveFileIndex(0);
  }, [fileQuery]);

  useEffect(() => {
    return model.subscribe(() => {
      const nextPath = model
        .getSelectedPaths()
        .slice()
        .reverse()
        .find((path) => files.some((file) => file.path === path));
      if (nextPath && nextPath !== selectedPathRef.current) {
        selectedPathRef.current = nextPath;
        setSelectedPath(nextPath);
        setTreeOpen(false);
      }
    });
  }, [files, model]);

  useEffect(() => {
    if (!selected?.contentUrl) {
      setFileError(selected?.path ?? null);
      return;
    }
    const controller = new AbortController();
    setFileError(null);
    fetch(selected.contentUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`File request failed: ${response.status}`);
        return response.text();
      })
      .then((nextContents) => {
        setContents(nextContents);
        setLoadedObjectId(selected.objectId);
        setFileError(null);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFileError(selected.path);
      });
    return () => controller.abort();
  }, [selected?.contentUrl, selected?.objectId]);

  const lineCount = useMemo(() => countLines(contents), [contents]);
  const codeItems = useMemo<CodeViewItem<undefined>[]>(
    () =>
      codeReady
        ? [
            {
              id: `file:${displayed.objectId}`,
              type: "file",
              file: {
                name: displayed.path,
                contents,
                cacheKey: displayed.objectId,
                lang: syntaxLanguageForFile(displayed.path, contents),
              },
            },
          ]
        : [],
    [codeReady, contents, displayed],
  );
  const codeViewOptions = useMemo<CodeViewOptions<undefined>>(
    () => ({
      layout: CODE_VIEW_LAYOUT,
      theme: DEFAULT_THEMES,
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

  return (
    <section className="code-workspace" aria-label="Code browser">
      <button
        className={treeOpen ? "workspace-backdrop is-visible" : "workspace-backdrop"}
        type="button"
        aria-label="Close file tree"
        onClick={() => setTreeOpen(false)}
      />
      <aside
        className={treeOpen ? "code-tree-panel is-mobile-open" : "code-tree-panel"}
        aria-label="Repository files"
      >
        <FileTree className="pierre-file-tree" model={model} header={treeHeader} />
      </aside>

      <article
        className="code-file"
        aria-label={viewFile?.path ?? "File viewer"}
      >
        {viewFile ? (
          <>
            <header className="code-file-header">
              <button
                className="mobile-tree-toggle"
                type="button"
                onClick={() => setTreeOpen(true)}
                aria-label="Open file tree"
              >
                <PanelLeft aria-hidden="true" />
              </button>
              <div className="file-breadcrumb" aria-label={viewFile.path}>
                {viewFile.path.split("/").map((part, index, parts) => (
                  <span key={`${part}-${index}`}>
                    {part}
                    {index < parts.length - 1 ? <ChevronRight aria-hidden="true" /> : null}
                  </span>
                ))}
              </div>
              <div className="code-file-meta">
                <button className="code-file-search" type="button" onClick={openFileSearch}>
                  <Search aria-hidden="true" />
                  <span>Jump to file</span>
                  <kbd>Ctrl F</kbd>
                </button>
                <span>{formatBytes(viewFile.size)}</span>
                {lineCount !== null ? <span>{lineCount} lines</span> : null}
              </div>
            </header>
            {fileError ? (
              <div className="code-file-tail-error" role="alert">
                Couldn’t display {fileError}.
              </div>
            ) : null}
            {codeReady ? (
              <CodeView
                key={renderer.disableWorkerPool ? "main" : "workers"}
                items={codeItems}
                className="code-file-frame code-view cv-scrollbar"
                disableWorkerPool={renderer.disableWorkerPool}
                options={codeViewOptions}
              />
            ) : fileError ? (
              <div className="code-file-frame">
                <div className="code-file-message">
                  <FileQuestion aria-hidden="true" />
                  <p>This file cannot be displayed as text.</p>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="code-file-message">This snapshot has no files.</div>
        )}
      </article>

      {fileSearchOpen ? (
        <div className="overlay" role="presentation" onMouseDown={() => setFileSearchOpen(false)}>
          <section
            className="search-dialog file-search-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Jump to file"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="search-field">
              <Search aria-hidden="true" />
              <input
                ref={fileSearchInputRef}
                value={fileQuery}
                onChange={(event) => setFileQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveFileIndex((current) =>
                      Math.min(current + 1, Math.max(0, fileSearchResults.length - 1)),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveFileIndex((current) => Math.max(0, current - 1));
                  } else if (event.key === "Enter") {
                    const match = fileSearchResults[activeFileIndex];
                    if (match) {
                      event.preventDefault();
                      selectFile(match.file.path);
                    }
                  }
                }}
                placeholder="Fuzzy search every file"
                aria-label="Fuzzy file search"
              />
              <button
                type="button"
                onClick={() => setFileSearchOpen(false)}
                aria-label="Close file search"
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="search-results file-search-results">
              {fileSearchResults.length ? (
                fileSearchResults.map(({ file }, index) => {
                  const parts = file.path.split("/");
                  const basename = parts.pop() ?? file.path;
                  const directory = parts.length ? `${parts.join("/")}/` : "Repository root";
                  return (
                    <button
                      className={
                        index === activeFileIndex
                          ? "search-result file-search-result is-active"
                          : "search-result file-search-result"
                      }
                      type="button"
                      key={file.path}
                      onMouseEnter={() => setActiveFileIndex(index)}
                      onClick={() => selectFile(file.path)}
                    >
                      <strong>{basename}</strong>
                      <small>{directory}</small>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  );
                })
              ) : (
                <p className="search-empty">No files found.</p>
              )}
            </div>
            <footer className="search-footer">
              <span>{fileSearchResults.length} results</span>
              <span>↑↓ move · Enter open · Esc close</span>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export const CodeBrowser = memo(forwardRef(CodeBrowserComponent));
