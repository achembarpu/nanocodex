"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo, useEffect, useLayoutEffect, useRef, } from "react";
import { Streamdown } from "streamdown";
export function TerminalTranscriptSurface({ canLoadOlder, composer, entries, followTailRequest = 0, inactiveMessage, isLoadingOlder, mode, showToolCalls = true, status, welcome, onLoadOlder, }) {
    const transcript = useRef(null);
    const followTail = useRef(true);
    const handledFollowTailRequest = useRef(followTailRequest);
    const loadOlderArmed = useRef(false);
    const preserveScroll = useRef(undefined);
    const visibleWelcome = entries.length === 0 ? welcome : undefined;
    useLayoutEffect(() => {
        const element = transcript.current;
        if (!element)
            return;
        if (handledFollowTailRequest.current !== followTailRequest) {
            handledFollowTailRequest.current = followTailRequest;
            followTail.current = true;
        }
        const preserved = preserveScroll.current;
        if (preserved) {
            preserveScroll.current = undefined;
            element.scrollTop = preserved.scrollTop + element.scrollHeight - preserved.scrollHeight;
        }
        else if (visibleWelcome)
            element.scrollTop = 0;
        else if (followTail.current)
            element.scrollTop = element.scrollHeight;
    }, [entries, followTailRequest, visibleWelcome]);
    useEffect(() => {
        const element = transcript.current;
        if (!element)
            return;
        const observer = new ResizeObserver(() => {
            if (visibleWelcome)
                element.scrollTop = 0;
            else if (followTail.current)
                element.scrollTop = element.scrollHeight;
        });
        const content = element.firstElementChild;
        observer.observe(element);
        if (content)
            observer.observe(content);
        return () => observer.disconnect();
    }, [visibleWelcome]);
    return (_jsxs("section", { className: `agent-terminal-shell is-dom is-${mode}`, "aria-label": "Live Nanocodex terminal", children: [_jsx("div", { ref: transcript, className: "agent-dom-transcript", role: "log", "aria-live": "off", onScroll: (event) => {
                    const element = event.currentTarget;
                    followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
                    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 22;
                    const nearTop = element.scrollTop <= lineHeight * 12;
                    if (!nearTop) {
                        if (!isLoadingOlder)
                            loadOlderArmed.current = true;
                        return;
                    }
                    if (!loadOlderArmed.current || isLoadingOlder || !canLoadOlder)
                        return;
                    loadOlderArmed.current = false;
                    preserveScroll.current = {
                        scrollHeight: element.scrollHeight,
                        scrollTop: element.scrollTop,
                    };
                    void onLoadOlder().then((loaded) => {
                        if (!loaded)
                            preserveScroll.current = undefined;
                    }).catch(() => {
                        preserveScroll.current = undefined;
                    });
                }, children: _jsxs("div", { className: "agent-dom-transcript-inner", children: [visibleWelcome ? _jsx("article", { className: "agent-terminal-markdown is-assistant is-welcome", children: _jsx(Streamdown, { components: MARKDOWN_COMPONENTS, controls: false, linkSafety: LINK_SAFETY, mode: "static", skipHtml: true, children: visibleWelcome }) }) : null, entries.map((entry) => (_jsx(TerminalEntryView, { entry: entry, showToolCalls: showToolCalls }, entry.id))), status !== "ready" && inactiveMessage ? (_jsx("p", { className: "agent-terminal-status", role: status === "error" ? "alert" : "status", children: inactiveMessage })) : null, _jsx("div", { className: "agent-transcript-keyboard-spacer", "aria-hidden": "true" })] }) }), composer] }));
}
const TerminalEntryView = memo(function TerminalEntryView({ entry, showToolCalls, }) {
    if (entry.kind === "user")
        return _jsx("pre", { className: "agent-terminal-user", children: entry.text });
    if (entry.kind === "assistant" || entry.kind === "reasoning")
        return (_jsxs("article", { className: `agent-terminal-markdown is-${entry.kind}`, children: [entry.kind === "reasoning" ? _jsxs("span", { className: "agent-terminal-entry-label", children: ["thinking", entry.streaming ? "…" : ""] }) : null, _jsx(Streamdown, { caret: entry.streaming ? "block" : undefined, components: MARKDOWN_COMPONENTS, controls: false, isAnimating: entry.streaming, linkSafety: LINK_SAFETY, mode: entry.streaming ? "streaming" : "static", skipHtml: true, children: entry.text })] }));
    if (entry.kind === "error")
        return _jsxs("p", { className: "agent-terminal-error", role: "alert", children: ["! ", entry.text] });
    if (entry.kind === "plan")
        return _jsx("ol", { className: "agent-terminal-plan", children: entry.update.plan.map((step, index) => _jsxs("li", { "data-status": step.status, children: [_jsx("span", { "aria-hidden": "true", children: step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "·" }), step.step] }, `${index}-${step.step}`)) });
    return showToolCalls ? _jsx(TerminalToolView, { tool: entry.tool }) : null;
});
function MarkdownInput({ node: _node, ref: _ref, ...props }) {
    return _jsx("input", { ...props, "aria-label": props["aria-label"] ?? (props.type === "checkbox" ? "Checklist item" : undefined) });
}
const MARKDOWN_COMPONENTS = { input: MarkdownInput };
const LINK_SAFETY = { enabled: true };
function TerminalToolView({ tool }) {
    return _jsxs("section", { className: `agent-terminal-tool is-${tool.status}`, children: [_jsxs("header", { children: [_jsx("span", { "aria-hidden": "true", children: tool.status === "completed" ? "✓" : tool.status === "running" ? "→" : "!" }), tool.name] }), tool.result ? _jsx("pre", { children: tool.result }) : null, tool.children.map((child) => _jsx(TerminalToolView, { tool: child }, child.callId))] });
}
