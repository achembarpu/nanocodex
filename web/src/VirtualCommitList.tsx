import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import { memo, useRef } from "react";
import type { HarnessCommit } from "./threadRepositorySnapshot";

type VirtualCommitListProps = {
  commits: HarnessCommit[];
  selectedHash?: string;
  onClearSearch(): void;
  onSelectCommit(commit: HarnessCommit): void;
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const relativeFormatter = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

function relativeDate(value: string) {
  const milliseconds = new Date(value).getTime() - Date.now();
  const hours = Math.round(milliseconds / 3_600_000);
  if (Math.abs(hours) < 24) return relativeFormatter.format(hours, "hour");
  const days = Math.round(milliseconds / 86_400_000);
  if (Math.abs(days) < 30) return relativeFormatter.format(days, "day");
  return dateFormatter.format(new Date(value));
}

export const VirtualCommitList = memo(function VirtualCommitList({
  commits,
  selectedHash,
  onClearSearch,
  onSelectCommit,
}: VirtualCommitListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 108,
    getItemKey: (index) => commits[index]?.hash ?? index,
    overscan: 8,
  });

  return (
    <div className="commit-list" ref={listRef}>
      {commits.length ? (
        <div
          style={{
            position: "relative",
            height: `${virtualizer.getTotalSize()}px`,
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const commit = commits[virtualRow.index];
            if (!commit) return null;
            const isSelected = commit.hash === selectedHash;
            return (
              <button
                className={isSelected ? "commit-row is-selected" : "commit-row"}
                type="button"
                key={commit.hash}
                aria-current={isSelected ? "location" : undefined}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() => onSelectCommit(commit)}
              >
                <span className="commit-meta">
                  <span>{commit.shortHash}</span>
                  <span>{relativeDate(commit.authoredAt)}</span>
                </span>
                <strong>{commit.subject}</strong>
                <span className="commit-byline">
                  {commit.author} · {commit.stats.files} file
                  {commit.stats.files === 1 ? "" : "s"}
                </span>
                <ChevronRight className="commit-chevron" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <p>No commits match this filter.</p>
          <button type="button" onClick={onClearSearch}>
            Clear search
          </button>
        </div>
      )}
    </div>
  );
});
