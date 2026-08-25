"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState, } from "react";
import { useAgentController, } from "nanocodex-react/agent";
import { TerminalComposer } from "./TerminalComposer.js";
import { TerminalTranscriptSurface } from "./TerminalTranscriptSurface.js";
/** Shared website terminal presentation. Runtime and authorization policy stay with its consumer. */
export function AgentTerminalView({ accessory, agent, agentError, controls, inactiveMessage, maxEntries, mode, onConversationActivity, onTerminalEvent, onStateChange, retryAgent, showToolCalls = true, welcome, }) {
    const [touchDraft, setTouchDraft] = useState("");
    const [pendingTouchSubmission, setPendingTouchSubmission] = useState();
    const [followTailRequest, setFollowTailRequest] = useState(0);
    const [readySessionId, setReadySessionId] = useState();
    const submittedPrompts = useRef([]);
    const pendingRootPrompts = useRef([]);
    const currentRootPrompt = useRef(undefined);
    const handleControllerEvent = useCallback((event) => {
        const observedEvent = observeControllerTiming({
            agentSessionId: agent?.sessionId,
            currentRootPrompt,
            event,
            pendingRootPrompts,
            submittedPrompts,
            onFirstOutput(firstOutput) {
                onTerminalEvent?.(firstOutput);
                const timingContext = {
                    eventSeq: firstOutput.eventSeq,
                    promptId: firstOutput.id,
                    sessionId: firstOutput.sessionId,
                };
                markAgentTiming("prompt.submit_to_first_token", Math.max(0, firstOutput.timestamp - firstOutput.submittedAt), timingContext);
                markAgentTiming("prompt.run_started_to_first_token", Math.max(0, firstOutput.timestamp - firstOutput.runStartedAt), timingContext);
            },
        });
        onTerminalEvent?.(observedEvent);
        if (observedEvent.type === "controller.attached"
            && typeof observedEvent.sessionId === "string") {
            submittedPrompts.current.length = 0;
            pendingRootPrompts.current.length = 0;
            currentRootPrompt.current = undefined;
            setReadySessionId(observedEvent.sessionId);
            markAgentTiming("terminal.ready");
        }
        else if (observedEvent.type === "controller.detached"
            && typeof observedEvent.sessionId === "string") {
            setReadySessionId((current) => current === observedEvent.sessionId ? undefined : current);
        }
        else if (observedEvent.type === "prompt.accepted"
            && typeof observedEvent.input === "string") {
            onConversationActivity(observedEvent.input);
            markAgentTiming("prompt.accepted");
        }
    }, [agent?.sessionId, onConversationActivity, onTerminalEvent]);
    const controller = useAgentController(agent, {
        maxEntries,
        visible: mode !== "hidden",
        onEvent: handleControllerEvent,
    });
    const agentStatus = agentError
        ? "error"
        : agent && readySessionId === agent.sessionId
            ? "ready"
            : "starting";
    const terminalRunning = agentStatus === "ready"
        && (controller.running || controller.pendingTurns > 0);
    useEffect(() => {
        onStateChange({ error: agentError, retry: retryAgent, status: agentStatus });
    }, [agentError, agentStatus, onStateChange, retryAgent]);
    const unavailableMessage = inactiveMessage?.({ agentError, agentStatus });
    const submitTouchPrompt = useCallback((input) => {
        if (!input.trim())
            return;
        const submittedAt = performance.now();
        setFollowTailRequest((current) => current + 1);
        if (agentStatus !== "ready") {
            setPendingTouchSubmission({ input, submittedAt });
            return;
        }
        submitPrompt(controller, submittedPrompts.current, input, submittedAt);
        setTouchDraft("");
    }, [agentStatus, controller]);
    useEffect(() => {
        if (agentStatus !== "ready" || !pendingTouchSubmission)
            return;
        submitPrompt(controller, submittedPrompts.current, pendingTouchSubmission.input, pendingTouchSubmission.submittedAt);
        setPendingTouchSubmission(undefined);
        setTouchDraft("");
    }, [agentStatus, controller, pendingTouchSubmission]);
    const cancelTouchTurn = useCallback(() => {
        if (agentStatus === "ready")
            void controller.cancel();
    }, [agentStatus, controller]);
    const submitAccessoryPrompt = useCallback((input) => {
        if (agentStatus !== "ready")
            return;
        const submittedAt = performance.now();
        setFollowTailRequest((current) => current + 1);
        retainSubmittedPrompt(submittedPrompts.current, input, submittedAt);
        void controller.submit(input, { intent: "queue" });
    }, [agentStatus, controller]);
    const terminal = (_jsx(TerminalTranscriptSurface, { composer: (_jsx(TerminalComposer, { controls: controls?.({ agentReady: agentStatus === "ready" }), draft: touchDraft, pending: pendingTouchSubmission !== undefined, running: terminalRunning, status: agentStatus, onCancel: cancelTouchTurn, onChange: (value) => {
                setPendingTouchSubmission(undefined);
                setTouchDraft(value);
            }, onSubmit: submitTouchPrompt })), canLoadOlder: controller.canLoadOlder, entries: controller.entries, followTailRequest: followTailRequest, inactiveMessage: unavailableMessage ?? "", isLoadingOlder: controller.isLoadingOlder, mode: mode, showToolCalls: showToolCalls, status: agentStatus, welcome: welcome, onLoadOlder: controller.loadOlder }));
    return mode === "full" ? (_jsxs("div", { className: "agent-terminal-workspace", children: [terminal, accessory?.({ agentReady: agentStatus === "ready", submit: submitAccessoryPrompt })] })) : terminal;
}
function submitPrompt(controller, submittedPrompts, input, submittedAt) {
    retainSubmittedPrompt(submittedPrompts, input, submittedAt);
    void controller.submit(input);
}
function retainSubmittedPrompt(submissions, input, submittedAt) {
    const prompt = input.trim();
    if (!prompt || prompt === "/clear" || prompt === "/cancel" || prompt === "/exit")
        return;
    submissions.push({ input: prompt, submittedAt });
}
function observeControllerTiming({ agentSessionId, currentRootPrompt, event, onFirstOutput, pendingRootPrompts, submittedPrompts, }) {
    if (event.type === "prompt.accepted"
        && typeof event.id === "number"
        && typeof event.input === "string") {
        const submittedAt = claimSubmittedAt(submittedPrompts.current, event.input, event.timestamp);
        pendingRootPrompts.current.push({
            firstOutputReported: false,
            id: event.id,
            submittedAt,
        });
        return { ...event, submittedAt };
    }
    if ((event.type === "prompt.steered" || event.type === "prompt.steer_error")
        && typeof event.input === "string") {
        claimSubmittedAt(submittedPrompts.current, event.input, event.timestamp);
    }
    if ((event.type === "prompt.completed" || event.type === "prompt.failed")
        && typeof event.id === "number") {
        const pendingIndex = pendingRootPrompts.current.findIndex((timing) => timing.id === event.id);
        if (pendingIndex >= 0)
            pendingRootPrompts.current.splice(pendingIndex, 1);
        if (currentRootPrompt.current?.id === event.id)
            currentRootPrompt.current = undefined;
    }
    if (event.type === "prompt.rejected" && typeof event.input === "string") {
        claimSubmittedAt(submittedPrompts.current, event.input, event.timestamp);
    }
    if (event.type !== "agent.event" || !isObservedAgentEvent(event.event, agentSessionId)) {
        return event;
    }
    const agentEvent = event.event;
    if (agentEvent.type === "run.started") {
        const timing = pendingRootPrompts.current.shift();
        if (timing)
            timing.runStartedAt = event.timestamp;
        currentRootPrompt.current = timing;
    }
    else if (agentEvent.type === "run.completed" || agentEvent.type === "run.failed") {
        currentRootPrompt.current = undefined;
    }
    else if ((agentEvent.type === "assistant.delta" || agentEvent.type === "reasoning.summary.delta")
        && typeof agentEvent.payload.text === "string"
        && agentEvent.payload.text.length > 0) {
        const timing = currentRootPrompt.current;
        if (timing && !timing.firstOutputReported && timing.runStartedAt !== undefined && agentSessionId) {
            timing.firstOutputReported = true;
            onFirstOutput({
                type: "prompt.first_output",
                timestamp: event.timestamp,
                eventSeq: agentEvent.seq,
                id: timing.id,
                runStartedAt: timing.runStartedAt,
                sessionId: agentSessionId,
                submittedAt: timing.submittedAt,
            });
        }
    }
    return event;
}
function claimSubmittedAt(submissions, input, fallback) {
    const index = submissions.findIndex((submission) => submission.input === input);
    if (index < 0)
        return fallback;
    return submissions.splice(index, 1)[0].submittedAt;
}
function isObservedAgentEvent(value, sessionId) {
    if (!value || typeof value !== "object")
        return false;
    const event = value;
    return event.request_id === sessionId
        && typeof event.seq === "number"
        && typeof event.type === "string"
        && typeof event.payload === "object"
        && event.payload !== null;
}
function markAgentTiming(stage, durationMs, context = {}) {
    const detail = { stage, ...(durationMs === undefined ? {} : { durationMs }), ...context };
    performance.mark(`nanocodex:${stage}`, { detail });
    console.info(`nanocodex:${stage}`, detail);
}
