import { ChevronRight, Menu, MessageSquare, Plus, X } from "lucide-react";
import { memo, useEffect, useRef } from "react";

export type ConversationSummary = Readonly<{
  id: string;
  title: string;
  updatedAt?: number;
  turnCount?: number;
}>;

export const ConversationHistoryRail = memo(function ConversationHistoryRail({
  conversations, error, mobileOpen, onClose, onCreate, onOpen, onSelect,
  pending, runtime, selectedId,
}: {
  conversations: readonly ConversationSummary[];
  error?: string;
  mobileOpen: boolean;
  onClose(): void;
  onCreate(): void;
  onOpen(): void;
  onSelect(id: string): void;
  pending: boolean;
  runtime: "local" | "managed";
  selectedId?: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mobileOpen) return;
    const keydown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", keydown);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", keydown);
  }, [mobileOpen, onClose]);
  const selected = conversations.find(({ id }) => id === selectedId);
  return <>
    <button
      className={mobileOpen ? "conversation-backdrop is-visible" : "conversation-backdrop"}
      type="button" aria-hidden="true" tabIndex={-1} onPointerDown={onClose}
    />
    <aside
      className={mobileOpen ? "conversation-sidebar is-mobile-open" : "conversation-sidebar"}
      aria-labelledby="conversation-history-title"
      role={mobileOpen ? "dialog" : "complementary"}
      aria-modal={mobileOpen || undefined}
    >
      <header className="conversation-sidebar-header">
        <div>
          <strong id="conversation-history-title">Conversations</strong>
          <span><MessageSquare aria-hidden="true" /> {runtime === "local" ? "this browser" : "managed account"}</span>
        </div>
        <nav className="conversation-sidebar-actions" aria-label="Conversation actions">
          <button className="conversation-icon-button" type="button" disabled={pending}
            aria-label="New conversation" title="New conversation" onClick={onCreate}>
            <Plus aria-hidden="true" />
          </button>
          <button ref={closeRef} className="conversation-drawer-close" type="button"
            aria-label="Close conversations" onClick={onClose}><X aria-hidden="true" /></button>
        </nav>
      </header>
      <div className="conversation-list">
        {conversations.map((conversation) => {
          const active = conversation.id === selectedId;
          return <button
            className={active ? "conversation-row is-selected" : "conversation-row"}
            type="button" key={conversation.id}
            aria-current={active ? "location" : undefined}
            onClick={() => onSelect(conversation.id)}
          >
            <span className="conversation-row-meta"><span>{conversation.id.slice(0, 8)}</span><span>{relativeTime(conversation.updatedAt)}</span></span>
            <strong>{conversation.title}</strong>
            <span className="conversation-row-byline">{conversation.turnCount === undefined
              ? runtime === "local" ? "Browser thread" : "Durable agent"
              : `${conversation.turnCount} turn${conversation.turnCount === 1 ? "" : "s"}`}</span>
            <ChevronRight aria-hidden="true" />
          </button>;
        })}
        {error ? <p className="conversation-list-error" role="alert">{error}</p> : null}
      </div>
    </aside>
    <header className="conversation-mobile-header">
      <button type="button" aria-label="Open conversations" onClick={onOpen}><Menu aria-hidden="true" /></button>
      <span>{selected?.title ?? "Conversations"}</span>
    </header>
  </>;
});

function relativeTime(value?: number): string {
  if (value === undefined) return "";
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}
