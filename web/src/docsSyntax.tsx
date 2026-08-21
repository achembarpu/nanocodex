import pierreDark from "@pierre/theme/pierre-dark-soft";
import pierreLight from "@pierre/theme/pierre-light";
import bash from "@shikijs/langs/bash";
import javascript from "@shikijs/langs/javascript";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import tsx from "@shikijs/langs/tsx";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

type DocsLanguage = "bash" | "javascript" | "python" | "rust" | "tsx";

const languageAliases: Record<string, DocsLanguage | undefined> = {
  bash: "bash",
  js: "javascript",
  javascript: "javascript",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  tsx: "tsx",
};

const highlighter = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine({ forgiving: true }),
  langs: [...bash, ...javascript, ...python, ...rust, ...tsx],
  themes: [toShikiTheme(pierreLight), toShikiTheme(pierreDark)],
});
const highlightCache = new Map<string, ReactNode>();
const MAX_HIGHLIGHT_CACHE_ENTRIES = 200;

function toShikiTheme(theme: typeof pierreLight) {
  return {
    bg: theme.colors["editor.background"],
    displayName: theme.displayName,
    fg: theme.colors["editor.foreground"],
    name: theme.name,
    settings: theme.tokenColors.map(({ name, scope, settings }) => ({
      name,
      scope,
      settings: { ...settings },
    })),
    type: theme.type,
  };
}

export function resolveDocsLanguage(language: string): DocsLanguage | undefined {
  return languageAliases[language.trim().toLowerCase()];
}

export function highlightDocsCode(code: string, language: string): ReactNode {
  const resolved = resolveDocsLanguage(language);
  if (!resolved) return code;
  const cacheKey = `${resolved}\0${code}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const { tokens } = highlighter.codeToTokens(code, {
      defaultColor: false,
      lang: resolved,
      themes: {
        dark: "pierre-dark-soft",
        light: "pierre-light",
      },
    });
    const highlighted = tokens.map((line, lineIndex) => (
      <Fragment key={lineIndex}>
        {line.map((token) => (
          <span
            className="docs-code-token"
            key={token.offset}
            style={
              typeof token.htmlStyle === "object"
                ? token.htmlStyle as CSSProperties
                : undefined
            }
          >
            {token.content}
          </span>
        ))}
        {lineIndex < tokens.length - 1 ? "\n" : null}
      </Fragment>
    ));
    highlightCache.set(cacheKey, highlighted);
    if (highlightCache.size > MAX_HIGHLIGHT_CACHE_ENTRIES) {
      const oldest = highlightCache.keys().next().value;
      if (oldest !== undefined) highlightCache.delete(oldest);
    }
    return highlighted;
  } catch {
    return code;
  }
}
