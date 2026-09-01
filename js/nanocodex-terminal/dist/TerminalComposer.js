"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { COARSE_POINTER_QUERY, terminalComposerAction } from "./policy.js";
/** One native, paste-capable composer shared by desktop and touch terminals. */
export function TerminalComposer({ controls, draft, pending, running, status, onCancel, onChange, onSubmit, }) {
    const composing = useRef(false);
    const textarea = useRef(null);
    useEffect(() => {
        const element = textarea.current;
        if (!element
            || status !== "ready"
            || window.matchMedia(COARSE_POINTER_QUERY).matches
            || (document.activeElement !== document.body && document.activeElement !== null))
            return;
        const frame = window.requestAnimationFrame(() => element.focus({ preventScroll: true }));
        return () => window.cancelAnimationFrame(frame);
    }, [status]);
    const submit = () => {
        const value = textarea.current?.value ?? draft;
        if (pending || !value.trim())
            return;
        onSubmit(value);
    };
    const action = terminalComposerAction(running, draft);
    return (_jsx("form", { className: `agent-touch-composer${running ? " is-running" : ""}`, "aria-label": "Nanocodex message composer", onSubmit: (event) => {
            event.preventDefault();
            submit();
        }, children: _jsxs("div", { className: "agent-touch-field", children: [_jsx("textarea", { ref: textarea, "aria-label": "Message Nanocodex", enterKeyHint: "send", rows: 1, value: draft, onChange: (event) => onChange(event.currentTarget.value), onCompositionStart: () => { composing.current = true; }, onCompositionEnd: (event) => {
                        composing.current = false;
                        onChange(event.currentTarget.value);
                    }, onKeyDown: (event) => {
                        if (!isSubmitKeyEvent(event.nativeEvent, composing.current))
                            return;
                        event.preventDefault();
                        submit();
                    } }), _jsxs("div", { className: "agent-touch-actions", children: [controls, action === "stop" ? (_jsx("button", { type: "button", "aria-label": "Stop response", disabled: status !== "ready", onClick: onCancel, children: _jsx(Square, { "aria-hidden": "true" }) })) : null, _jsx("button", { type: "submit", "aria-label": "Send message", disabled: pending || status !== "ready", children: _jsx(ArrowUp, { "aria-hidden": "true" }) })] })] }) }));
}
function isSubmitKeyEvent(event, composing) {
    return event.key === "Enter"
        && !event.shiftKey
        && !event.isComposing
        && !composing;
}
