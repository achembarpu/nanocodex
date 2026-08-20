"use client";

import { Check, ChevronLeft, ChevronRight, Copy, Menu, X } from "lucide-react";
import {
  Fragment,
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router";
import { parseDocument, type MarkdownBlock } from "./docsMarkdown";
import "./Docs.css";

const sources = import.meta.glob("../docs/src/pages/**/*.mdx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

type NavPage = readonly [label: string, href: string];
type NavGroup = { label: string; pages: readonly NavPage[] };

const navGroups: readonly NavGroup[] = [
  {
    label: "Start",
    pages: [
      ["Overview", "/docs"],
      ["Getting started", "/docs/getting-started"],
      ["Stability and scope", "/docs/stability"],
    ],
  },
  {
    label: "Core",
    pages: [
      ["The owned agent", "/docs/core/owned-agent"],
      ["Durable execution", "/docs/core/durability"],
      ["Tools and Code Mode", "/docs/core/tools-code-mode"],
      ["Branches and subagents", "/docs/core/branching"],
    ],
  },
  {
    label: "SDKs",
    pages: [
      ["Rust", "/docs/sdks/rust"],
      ["JavaScript", "/docs/sdks/javascript"],
      ["Python", "/docs/sdks/python"],
    ],
  },
  {
    label: "Capabilities",
    pages: [
      ["Web agent", "/docs/capabilities/web-agent"],
      ["VMs and sandboxes", "/docs/capabilities/vm-sandboxes"],
      ["Voice", "/docs/capabilities/voice"],
      ["Deployment patterns", "/docs/deployments"],
    ],
  },
  {
    label: "Proof",
    pages: [
      ["Evaluation", "/docs/evals"],
      ["Built with Nanocodex: Tact", "/docs/examples/tact"],
    ],
  },
] as const;

const pageOrder: NavPage[] = navGroups.flatMap(({ pages }) => [...pages]);
const documents = new Map(
  Object.entries(sources).map(([file, source]) => [routeForSource(file), source]),
);

export function Docs() {
  const location = useLocation();
  const path = normalizePath(location.pathname);
  const source = documents.get(path);
  const doc = useMemo(() => source ? parseDocument(source) : undefined, [source]);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const browseButtonRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setBrowseOpen(false);
    setCopied(false);
    window.requestAnimationFrame(() => {
      const target = location.hash
        ? window.document.getElementById(decodeURIComponent(location.hash.slice(1)))
        : null;
      if (target) target.scrollIntoView();
      else window.scrollTo({ top: 0 });
    });
    window.document.title = doc ? `${doc.title} · Nanocodex docs` : "Docs · Nanocodex";
  }, [doc, location.hash, path]);

  useEffect(() => {
    if (!browseOpen) return;
    const overflow = window.document.documentElement.style.overflow;
    window.document.documentElement.style.overflow = "hidden";
    drawerCloseRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBrowseOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.document.documentElement.style.overflow = overflow;
      browseButtonRef.current?.focus();
    };
  }, [browseOpen]);

  if (!doc || !source) {
    return (
      <section className="docs-not-found">
        <p className="eyebrow">Nanocodex docs</p>
        <h1>That page is not in the manual.</h1>
        <a href="/docs">Browse the documentation</a>
      </section>
    );
  }

  const headings = doc.blocks.filter(
    (block): block is Extract<MarkdownBlock, { type: "heading" }> =>
      block.type === "heading" && block.depth === 2,
  );
  const currentIndex = pageOrder.findIndex(([, href]) => href === path);
  const previous = currentIndex > 0 ? pageOrder[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 ? pageOrder[currentIndex + 1] : undefined;
  const copyMarkdown = () => {
    void navigator.clipboard.writeText(source).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <div className="docs-page">
      <div className="docs-mobile-toolbar">
        <button
          ref={browseButtonRef}
          type="button"
          aria-expanded={browseOpen}
          aria-controls="docs-mobile-navigation"
          onClick={() => setBrowseOpen(true)}
        >
          <Menu aria-hidden="true" /> Browse
        </button>
        <CopyMarkdownButton copied={copied} onClick={copyMarkdown} />
      </div>

      <div className="docs-layout">
        <aside className="docs-sidebar">
          <DocsNavigation path={path} />
        </aside>

        <div className="docs-reading-column">
          <CopyMarkdownButton copied={copied} onClick={copyMarkdown} />
          <article className="docs-article" id="docs-content">
            {doc.blocks.map((block, index) => (
              <MarkdownBlockView block={block} key={`${block.type}-${index}`} />
            ))}
          </article>
          <nav className="docs-pagination" aria-label="Adjacent documentation pages">
            {previous ? (
              <a href={previous[1]}>
                <ChevronLeft aria-hidden="true" />
                <span><small>Previous</small>{previous[0]}</span>
              </a>
            ) : <span />}
            {next ? (
              <a href={next[1]}>
                <span><small>Next</small>{next[0]}</span>
                <ChevronRight aria-hidden="true" />
              </a>
            ) : null}
          </nav>
        </div>

        <aside className="docs-on-this-page" aria-label="On this page">
          <p>On this page</p>
          {headings.map((heading) => (
            <a href={`#${heading.id}`} key={heading.id}>{stripMarkdown(heading.text)}</a>
          ))}
        </aside>
      </div>

      {browseOpen ? (
        <div className="docs-drawer-layer">
          <button
            className="docs-drawer-backdrop"
            type="button"
            aria-label="Close documentation navigation"
            onClick={() => setBrowseOpen(false)}
          />
          <aside
            className="docs-drawer"
            id="docs-mobile-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Documentation navigation"
          >
            <header>
              <span>Documentation</span>
              <button ref={drawerCloseRef} type="button" aria-label="Close" onClick={() => setBrowseOpen(false)}>
                <X aria-hidden="true" />
              </button>
            </header>
            <DocsNavigation path={path} />
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function DocsNavigation({ path }: { path: string }) {
  return (
    <nav aria-label="Documentation">
      {navGroups.map((group) => (
        <section key={group.label}>
          <p>{group.label}</p>
          {group.pages.map(([label, href]) => (
            <a href={href} aria-current={href === path ? "page" : undefined} key={href}>
              {label}
            </a>
          ))}
        </section>
      ))}
    </nav>
  );
}

function CopyMarkdownButton({ copied, onClick }: { copied: boolean; onClick(): void }) {
  return (
    <button className="docs-copy-markdown" type="button" onClick={onClick}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span>{copied ? "Copied" : "Copy markdown"}</span>
    </button>
  );
}

function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
  if (block.type === "heading") {
    return createElement(
      `h${block.depth}`,
      { id: block.id },
      block.depth > 1 ? <a href={`#${block.id}`}>{inline(block.text)}</a> : inline(block.text),
    );
  }
  if (block.type === "paragraph") return <p>{inline(block.text)}</p>;
  if (block.type === "code") return <CodeBlock code={block.code} language={block.language} />;
  if (block.type === "list") {
    const List = block.ordered ? "ol" : "ul";
    return <List>{block.items.map((item, index) => <li key={index}>{inline(item)}</li>)}</List>;
  }
  return (
    <div className="docs-table-scroll">
      <table>
        <thead><tr>{block.headers.map((header) => <th key={header}>{inline(header)}</th>)}</tr></thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="docs-code-block">
      <span>{language || "text"}</span>
      <button
        type="button"
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          });
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      <pre tabIndex={0}><code>{code}</code></pre>
    </div>
  );
}

function inline(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(value.slice(cursor, start));
    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = docsHref(link[2]);
      nodes.push(
        <a
          href={href}
          target={/^https?:/.test(href) ? "_blank" : undefined}
          rel={/^https?:/.test(href) ? "noreferrer" : undefined}
          key={`${start}-${href}`}
        >
          {link[1]}
        </a>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(<code key={start}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={start}>{token.slice(2, -2)}</strong>);
    }
    cursor = start + token.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

function routeForSource(file: string) {
  const relative = file.split("/pages/")[1].replace(/\.mdx$/, "");
  return relative === "index" ? "/docs" : `/docs/${relative}`;
}

function normalizePath(pathname: string) {
  const path = pathname.replace(/\/+$/, "");
  return path || "/docs";
}

function docsHref(href: string) {
  if (!href.startsWith("/") || href.startsWith("/docs")) return href;
  return `/docs${href}`;
}

function stripMarkdown(value: string) {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]/g, "");
}
