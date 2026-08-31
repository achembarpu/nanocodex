import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { ChevronRight, Menu, MessageSquare, Plus, X } from "lucide-react";
import { memo, useEffect, useId, useRef } from "react";
export const ConversationHistoryRail = memo(function ConversationHistoryRail({ agentStatus, conversations, error, mobileOpen, onClose, onCreate, onOpen, onRetry, onSelect, pending, runtime, selectedId, }) {
    const titleId = useId();
    const closeRef = useRef(null);
    useEffect(() => {
        if (!mobileOpen)
            return;
        const keydown = (event) => event.key === "Escape" && onClose();
        window.addEventListener("keydown", keydown);
        closeRef.current?.focus();
        return () => window.removeEventListener("keydown", keydown);
    }, [mobileOpen, onClose]);
    const selected = conversations.find(({ id }) => id === selectedId);
    return _jsxs(_Fragment, { children: [_jsx("div", { className: mobileOpen ? "conversation-backdrop is-visible" : "conversation-backdrop", "aria-hidden": "true", onPointerDown: onClose }), _jsxs("aside", { className: mobileOpen ? "conversation-sidebar is-mobile-open" : "conversation-sidebar", "aria-labelledby": titleId, role: mobileOpen ? "dialog" : "complementary", "aria-modal": mobileOpen || undefined, children: [_jsxs("header", { className: "conversation-sidebar-header", children: [_jsxs("div", { children: [_jsx("strong", { id: titleId, children: "Conversations" }), _jsxs("span", { children: [_jsx(MessageSquare, { "aria-hidden": "true" }), " ", runtime === "local" ? "this browser" : "managed account"] })] }), _jsxs("nav", { className: "conversation-sidebar-actions", "aria-label": "Conversation actions", children: [onCreate ? _jsx("button", { className: "conversation-icon-button", type: "button", disabled: pending, "aria-label": "New conversation", title: "New conversation", onClick: onCreate, children: _jsx(Plus, { "aria-hidden": "true" }) }) : null, _jsx("button", { ref: closeRef, className: "conversation-drawer-close", type: "button", "aria-label": "Close conversations", onClick: onClose, children: _jsx(X, { "aria-hidden": "true" }) })] })] }), _jsxs("div", { className: "conversation-list", children: [conversations.map((conversation) => {
                                const active = conversation.id === selectedId;
                                const title = conversationDisplayTitle(conversation.title);
                                return _jsxs("button", { className: active ? "conversation-row is-selected" : "conversation-row", type: "button", disabled: pending, "aria-current": active ? "location" : undefined, onClick: () => onSelect(conversation.id), children: [_jsx("strong", { children: title }), _jsxs("span", { className: "conversation-row-meta", children: [_jsx("span", { children: relativeTime(conversation.updatedAt) }), _jsx("span", { "aria-hidden": "true", children: "\u00B7" }), _jsx("span", { children: conversation.turnCount === undefined
                                                        ? runtime === "local" ? "Browser thread" : "Durable agent"
                                                        : `${conversation.turnCount} turn${conversation.turnCount === 1 ? "" : "s"}` })] }), _jsx(ChevronRight, { "aria-hidden": "true" })] }, conversation.id);
                            }), error ? _jsxs("div", { className: "conversation-list-error", children: [_jsx("p", { role: "alert", children: error }), _jsx("button", { type: "button", disabled: pending, onClick: onRetry, children: "Retry conversations" })] }) : null] })] }), _jsxs("header", { className: "conversation-mobile-header", children: [_jsx("button", { type: "button", "aria-label": "Open conversations", onClick: onOpen, children: _jsx(Menu, { "aria-hidden": "true" }) }), _jsxs("div", { className: "conversation-mobile-title", children: [_jsx("strong", { children: selected ? conversationDisplayTitle(selected.title) : "Conversations" }), _jsxs("span", { className: `conversation-mobile-status is-${agentStatus}`, children: [_jsx("i", { "aria-hidden": "true" }), statusLabel(agentStatus)] })] }), onCreate ? _jsxs("button", { className: "conversation-mobile-new", type: "button", disabled: pending, "aria-label": "New conversation", onClick: onCreate, children: [_jsx(Plus, { "aria-hidden": "true" }), _jsx("span", { children: "New" })] }) : null] })] });
});
function relativeTime(value) {
    if (value === undefined)
        return "";
    const elapsed = Math.max(0, Date.now() - value);
    if (elapsed < 60_000)
        return "now";
    if (elapsed < 3_600_000)
        return `${Math.floor(elapsed / 60_000)}m`;
    if (elapsed < 86_400_000)
        return `${Math.floor(elapsed / 3_600_000)}h`;
    return `${Math.floor(elapsed / 86_400_000)}d`;
}
function statusLabel(status) {
    if (status === "ready")
        return "ready";
    if (status === "error")
        return "needs attention";
    if (status === "starting")
        return "connecting";
    return "waiting";
}
function conversationDisplayTitle(title) {
    return /^Conversation [a-f\d]{8}$/i.test(title) ? "New conversation" : title;
}
