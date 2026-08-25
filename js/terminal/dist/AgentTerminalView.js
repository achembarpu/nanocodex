"use client";
import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState, } from "react";
import { useAgentController, } from "nanocodex-react/agent";
import { useVoice, } from "nanocodex-react";
import { TerminalComposer } from "./TerminalComposer.js";
import { TerminalTranscriptSurface } from "./TerminalTranscriptSurface.js";
/** Shared website terminal presentation. Runtime and authorization policy stay with its consumer. */
export function AgentTerminalView({ accessory, agent, agentError, controls, inactiveMessage, maxEntries, mode, onConversationActivity, onTerminalEvent, onStateChange, promptIntent, retryAgent, showToolCalls = true, voice = false, voiceOptions, welcome, }) {
    const [touchDraft, setTouchDraft] = useState("");
    const [pendingTouchSubmission, setPendingTouchSubmission] = useState();
    const [followTailRequest, setFollowTailRequest] = useState(0);
    const [readySessionId, setReadySessionId] = useState();
    const [voiceEntries, setVoiceEntries] = useState([]);
    const submittedPrompts = useRef([]);
    const pendingRootPrompts = useRef([]);
    const currentRootPrompt = useRef(undefined);
    const consumedVoiceTranscripts = useRef(0);
    const voiceEntrySequence = useRef(0);
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
    const voiceState = useVoice(agent?.voiceSource ?? agent, { ...voiceOptions, enabled: voice && mode !== "hidden" });
    const maxVoiceEntries = Number.isSafeInteger(maxEntries) && (maxEntries ?? 0) > 0
        ? maxEntries
        : 200;
    const agentStatus = agentError
        ? "error"
        : agent && readySessionId === agent.sessionId
            ? "ready"
            : "starting";
    const terminalRunning = agentStatus === "ready"
        && (controller.running || controller.pendingTurns > 0);
    useEffect(() => {
        setVoiceEntries([]);
        consumedVoiceTranscripts.current = 0;
        voiceEntrySequence.current = 0;
    }, [agent?.sessionId]);
    useEffect(() => {
        const transcripts = voiceState.transcripts;
        if (transcripts.length === 0) {
            consumedVoiceTranscripts.current = 0;
            return;
        }
        const start = Math.min(consumedVoiceTranscripts.current, transcripts.length);
        consumedVoiceTranscripts.current = transcripts.length;
        if (start === transcripts.length)
            return;
        const afterEntryId = controller.entries.at(-1)?.id;
        const appended = transcripts.slice(start).map((transcript) => ({
            afterEntryId,
            id: `voice-${agent?.sessionId ?? "detached"}-${voiceEntrySequence.current++}`,
            kind: transcript.speaker,
            source: "voice",
            streaming: false,
            text: transcript.text,
        }));
        setVoiceEntries((current) => [...current, ...appended].slice(-maxVoiceEntries));
        setFollowTailRequest((current) => current + 1);
    }, [agent?.sessionId, controller.entries, maxVoiceEntries, voiceState.transcripts]);
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
        submitPrompt(controller, submittedPrompts.current, input, submittedAt, promptIntent);
        setTouchDraft("");
    }, [agentStatus, controller, promptIntent]);
    useEffect(() => {
        if (agentStatus !== "ready" || !pendingTouchSubmission)
            return;
        submitPrompt(controller, submittedPrompts.current, pendingTouchSubmission.input, pendingTouchSubmission.submittedAt, promptIntent);
        setPendingTouchSubmission(undefined);
        setTouchDraft("");
    }, [agentStatus, controller, pendingTouchSubmission, promptIntent]);
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
    const terminal = (_jsx(TerminalTranscriptSurface, { composer: (_jsx(TerminalComposer, { controls: (voice || controls) ? _jsxs(_Fragment, { children: [voice ? _jsx(VoiceControl, { agentReady: agentStatus === "ready", voice: voiceState }) : null, controls?.({ agentReady: agentStatus === "ready" })] }) : undefined, draft: touchDraft, pending: pendingTouchSubmission !== undefined, running: terminalRunning, status: agentStatus, onCancel: cancelTouchTurn, onChange: (value) => {
                setPendingTouchSubmission(undefined);
                setTouchDraft(value);
            }, onSubmit: submitTouchPrompt })), canLoadOlder: controller.canLoadOlder, entries: controller.entries, followTailRequest: followTailRequest, inactiveMessage: unavailableMessage ?? "", isLoadingOlder: controller.isLoadingOlder, mode: mode, showToolCalls: showToolCalls, status: agentStatus, voiceEntries: voiceEntries, welcome: welcome, onLoadOlder: controller.loadOlder }));
    return mode === "full" ? (_jsxs("div", { className: "agent-terminal-workspace", children: [terminal, accessory?.({ agentReady: agentStatus === "ready", submit: submitAccessoryPrompt })] })) : terminal;
}
function VoiceControl({ agentReady, voice, }) {
    const engaged = voice.isActive || voice.isConnecting;
    return _jsxs(_Fragment, { children: [_jsxs("button", { className: "agent-voice-button", type: "button", "aria-label": engaged ? "Stop voice" : "Start voice", "aria-pressed": engaged, disabled: !agentReady, onClick: () => { void voice.toggle().catch(() => { }); }, children: [_jsx("svg", { "aria-hidden": "true", viewBox: "0 0 24 24", children: _jsx("path", { d: "M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm-7-3a1 1 0 1 1 2 0 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.08A7 7 0 0 1 5 12Z" }) }), _jsx("span", { className: "agent-terminal-sr-only", children: "Voice" })] }), voice.isActive ? (_jsx("span", { className: "agent-terminal-sr-only", role: "status", children: voice.voice })) : null, voice.isError ? (_jsx("span", { className: "agent-voice-error", role: "alert", children: voice.error?.message ?? "Voice failed. Check microphone access and retry." })) : null] });
}
function submitPrompt(controller, submittedPrompts, input, submittedAt, intent) {
    retainSubmittedPrompt(submittedPrompts, input, submittedAt);
    void controller.submit(input, intent === undefined ? undefined : { intent });
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
