"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, } from "react";
import { Streamdown } from "streamdown";
export function TerminalTranscriptSurface({ canLoadOlder, composer, entries, followTailRequest = 0, inactiveMessage, isLoadingOlder, mode, showToolCalls = true, status, voiceEntries = [], welcome, onLoadOlder, }) {
    const transcript = useRef(null);
    const followTail = useRef(true);
    const handledFollowTailRequest = useRef(followTailRequest);
    const loadOlderArmed = useRef(false);
    const preserveScroll = useRef(undefined);
    const transcriptEntries = useMemo(() => interleaveTranscriptEntries(entries, voiceEntries), [entries, voiceEntries]);
    const visibleWelcome = transcriptEntries.length === 0 ? welcome : undefined;
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
    }, [followTailRequest, transcriptEntries, visibleWelcome]);
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
                }, children: _jsxs("div", { className: "agent-dom-transcript-inner", children: [visibleWelcome ? _jsx("article", { className: "agent-terminal-markdown is-assistant is-welcome", children: _jsx(Streamdown, { components: MARKDOWN_COMPONENTS, controls: false, linkSafety: LINK_SAFETY, mode: "static", skipHtml: true, children: visibleWelcome }) }) : null, transcriptEntries.map((entry) => (_jsx(TerminalEntryView, { entry: entry, showToolCalls: showToolCalls }, entry.id))), status !== "ready" && inactiveMessage ? (_jsx("p", { className: "agent-terminal-status", role: status === "error" ? "alert" : "status", children: inactiveMessage })) : null, _jsx("div", { className: "agent-transcript-keyboard-spacer", "aria-hidden": "true" })] }) }), composer] }));
}
export function interleaveTranscriptEntries(entries, voiceEntries) {
    const anchored = new Map();
    const liveVoiceByKey = new Map();
    for (const entry of voiceEntries) {
        const group = anchored.get(entry.afterEntryId) ?? [];
        group.push(entry);
        anchored.set(entry.afterEntryId, group);
        const key = voiceEntryKey(entry);
        const matching = liveVoiceByKey.get(key) ?? [];
        matching.push(entry);
        liveVoiceByKey.set(key, matching);
    }
    const merged = [];
    const matchedLiveVoiceIds = new Set();
    const retainedVoiceIds = new Set();
    for (const voiceEntry of anchored.get(undefined) ?? []) {
        appendVoiceEntry(merged, voiceEntry);
        retainedVoiceIds.add(voiceEntry.id);
    }
    for (const entry of entries) {
        const durableVoiceEntries = projectRealtimeTranscript(entry);
        if (durableVoiceEntries !== undefined) {
            for (const voiceEntry of durableVoiceEntries) {
                const key = voiceEntryKey(voiceEntry);
                const liveEntry = liveVoiceByKey.get(key)?.find(({ id }) => !matchedLiveVoiceIds.has(id));
                if (liveEntry) {
                    matchedLiveVoiceIds.add(liveEntry.id);
                    if (!retainedVoiceIds.has(liveEntry.id)) {
                        appendVoiceEntry(merged, liveEntry);
                        retainedVoiceIds.add(liveEntry.id);
                    }
                }
                else
                    merged.push(voiceEntry);
            }
            for (const voiceEntry of anchored.get(entry.id) ?? []) {
                if (retainedVoiceIds.has(voiceEntry.id))
                    continue;
                appendVoiceEntry(merged, voiceEntry);
                retainedVoiceIds.add(voiceEntry.id);
            }
            continue;
        }
        merged.push(entry);
        for (const voiceEntry of anchored.get(entry.id) ?? []) {
            if (retainedVoiceIds.has(voiceEntry.id))
                continue;
            appendVoiceEntry(merged, voiceEntry);
            retainedVoiceIds.add(voiceEntry.id);
        }
    }
    for (const entry of voiceEntries) {
        if (!retainedVoiceIds.has(entry.id) && entry.afterEntryId === undefined) {
            appendVoiceEntry(merged, entry);
        }
    }
    return merged;
}
function appendVoiceEntry(entries, voiceEntry) {
    entries.push(voiceEntry);
}
function isVoiceEntry(entry) {
    return "source" in entry && entry.source === "voice";
}
function normalizeTranscript(text) {
    return text.trim().replace(/\s+/g, " ");
}
function voiceEntryKey(entry) {
    return `${entry.kind}:${normalizeTranscript(entry.text)}`;
}
function projectRealtimeTranscript(entry) {
    if (entry.kind !== "user" || !entry.text.startsWith("<realtime_delegation>"))
        return undefined;
    const encoded = /<transcript_delta>([\s\S]*?)<\/transcript_delta>/.exec(entry.text)?.[1];
    if (!encoded)
        return [];
    const projected = [];
    const unlabelled = [];
    for (const line of decodeRealtimeText(encoded).split("\n")) {
        const turn = /^(user|assistant):\s?(.*)$/.exec(line);
        if (turn) {
            projected.push({ kind: turn[1], text: turn[2] ?? "" });
        }
        else if (projected.length > 0) {
            projected[projected.length - 1].text += `\n${line}`;
        }
        else
            unlabelled.push(line);
    }
    const unlabelledText = unlabelled.join("\n").trim();
    if (unlabelledText)
        projected.unshift({ kind: "assistant", text: unlabelledText });
    return projected
        .filter(({ text }) => text.trim().length > 0)
        .map(({ kind, text }, index) => ({
        id: `${entry.id}-voice-${index}`,
        kind,
        source: "voice",
        streaming: false,
        text,
    }));
}
function decodeRealtimeText(text) {
    return text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
}
const TerminalEntryView = memo(function TerminalEntryView({ entry, showToolCalls, }) {
    const voice = isVoiceEntry(entry);
    if (entry.kind === "user")
        return _jsxs("pre", { className: "agent-terminal-user", "data-source": voice ? "voice" : undefined, children: [voice ? _jsx("span", { className: "agent-terminal-entry-label", children: "voice" }) : null, entry.text] });
    if (entry.kind === "assistant" || entry.kind === "reasoning")
        return (_jsxs("article", { className: `agent-terminal-markdown is-${entry.kind}`, "data-source": voice ? "voice" : undefined, children: [voice ? _jsx("span", { className: "agent-terminal-entry-label", children: "voice" }) : null, entry.kind === "reasoning" ? _jsxs("span", { className: "agent-terminal-entry-label", children: ["thinking", entry.streaming ? "…" : ""] }) : null, _jsx(Streamdown, { caret: entry.streaming ? "block" : undefined, components: MARKDOWN_COMPONENTS, controls: false, isAnimating: entry.streaming, linkSafety: LINK_SAFETY, mode: entry.streaming ? "streaming" : "static", skipHtml: true, children: entry.text })] }));
    if (entry.kind === "error")
        return _jsxs("p", { className: "agent-terminal-error", role: "alert", children: ["! ", entry.text] });
    if (entry.kind === "plan")
        return _jsx("ol", { className: "agent-terminal-plan", children: entry.update.plan.map((step, index) => _jsxs("li", { "data-status": step.status, children: [_jsx("span", { "aria-hidden": "true", children: step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "·" }), step.step] }, `${index}-${step.step}`)) });
    if (entry.kind === "tool")
        return showToolCalls ? _jsx(TerminalToolView, { tool: entry.tool }) : null;
    return null;
});
function MarkdownInput({ node: _node, ref: _ref, ...props }) {
    return _jsx("input", { ...props, "aria-label": props["aria-label"] ?? (props.type === "checkbox" ? "Checklist item" : undefined) });
}
const MARKDOWN_COMPONENTS = { input: MarkdownInput };
const LINK_SAFETY = { enabled: true };
function TerminalToolView({ tool }) {
    return _jsxs("section", { className: `agent-terminal-tool is-${tool.status}`, children: [_jsxs("header", { children: [_jsx("span", { "aria-hidden": "true", children: tool.status === "completed" ? "✓" : tool.status === "running" ? "→" : "!" }), tool.name] }), tool.result ? _jsx("pre", { children: tool.result }) : null, tool.children.map((child) => _jsx(TerminalToolView, { tool: child }, child.callId))] });
}
