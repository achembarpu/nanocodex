import type { Workspace } from "nanocodex/browser/workspace";
import type { AgentEvent, TuiTarget, VoiceSessionContext } from "nanocodex-tui";

import type { TuiMessage as WebTuiMessage } from "nanocodex-tui";
import {
  browserVoiceStartupContext,
  type VoiceTranscriptEntry,
} from "./voiceProtocol.js";

export const CHATGPT_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const;

export type ChatGptVoice = typeof CHATGPT_VOICES[number];

export type BrowserVoiceDelegation =
  | { kind: "request"; input: string; transcript: VoiceTranscriptEntry[] }
  | { kind: "tail"; transcript: VoiceTranscriptEntry[] };

export type BrowserVoiceOptions = {
  sessionId: string;
  target: TuiTarget;
  voice: ChatGptVoice;
  callUrl?: string | URL;
  sidebandUrl?(callId: string, sessionId: string): string | URL;
  workspace(): Promise<Workspace>;
  onStart(): Promise<VoiceSessionContext>;
  onStop(): Promise<void>;
  onDelegation(delegation: BrowserVoiceDelegation): void;
  onStatus(status: string): void;
  onTranscript(speaker: "user" | "assistant", text: string): void;
};

type PlaybackGestureTarget = Pick<Document, "addEventListener" | "removeEventListener">;

/** Owns browser speaker playback and retries it from the next user gesture when autoplay is blocked. */
export class SpeakerPlayback {
  readonly #speaker: HTMLAudioElement;
  readonly #gestures: PlaybackGestureTarget;
  readonly #onStatus: (status: string) => void;
  #resume?: EventListener;
  #closed = false;

  constructor(
    speaker: HTMLAudioElement,
    onStatus: (status: string) => void,
    gestures: PlaybackGestureTarget = document,
  ) {
    this.#speaker = speaker;
    this.#onStatus = onStatus;
    this.#gestures = gestures;
    this.#speaker.autoplay = true;
  }

  attach(stream: MediaStream): void {
    if (this.#closed) return;
    this.#speaker.srcObject = stream;
    this.#play();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#disarm();
    this.#speaker.pause();
    this.#speaker.srcObject = null;
  }

  #play(): void {
    if (this.#closed) return;
    this.#disarm();
    void this.#speaker.play().catch(() => {
      if (this.#closed) return;
      this.#onStatus("Voice connected — tap once to enable speaker audio");
      const resume: EventListener = () => {
        if (this.#resume !== resume) return;
        this.#resume = undefined;
        this.#gestures.removeEventListener("pointerdown", resume, true);
        this.#play();
      };
      this.#resume = resume;
      this.#gestures.addEventListener("pointerdown", resume, { capture: true, once: true });
    });
  }

  #disarm(): void {
    if (!this.#resume) return;
    this.#gestures.removeEventListener("pointerdown", this.#resume, true);
    this.#resume = undefined;
  }
}

const MAX_CONTEXT_APPEND_BYTES = 500;
const OUTPUT_FLUSH_MS = 200;
const REALTIME_OUTPUT_BYTE_LIMIT = 4_000;
const HANDOFF_STREAM_TRUNCATION_MARKER = "\n…output truncated…\n";

/** Main-thread browser media and ChatGPT Realtime lifecycle. */
export class BrowserVoiceSession {
  readonly #options: BrowserVoiceOptions;
  #peer?: RTCPeerConnection;
  #channel?: RTCDataChannel;
  #sideband?: WebSocket;
  #microphone?: MediaStream;
  #speaker?: SpeakerPlayback;
  #call?: AbortController;
  #transcript: VoiceTranscriptEntry[] = [];
  #newInputEntry = false;
  #newOutputEntry = false;
  #activeDelegation?: string;
  #output = new HandoffStream();
  #flushTimer?: number;
  #streamedThisMessage = false;
  #outputSentThisRun = false;
  #runError?: string;
  #lifecycleStart?: Promise<VoiceSessionContext>;
  #closePromise?: Promise<void>;
  #closed = false;

  constructor(options: BrowserVoiceOptions) {
    this.#options = options;
  }

  get target(): TuiTarget {
    return this.#options.target;
  }

  async start(): Promise<void> {
    const lifecycleStart = this.#options.onStart();
    this.#lifecycleStart = lifecycleStart;
    const context = await lifecycleStart;
    if (this.#closed) return;
    const workspace = await this.#options.workspace().catch(() => undefined);
    const startupContext = await browserVoiceStartupContext(context, workspace);
    if (this.#closed) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("this browser does not expose microphone capture");
    }
    let microphone = await captureMicrophone({ audio: voiceAudioConstraints() });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const initialTrack = microphone.getAudioTracks()[0];
    const physicalInput = preferredPhysicalInput(devices, initialTrack?.label);
    if (initialTrack && isVirtualAudioInput(initialTrack.label) && physicalInput) {
      const physicalMicrophone = await captureMicrophone({
        audio: { ...voiceAudioConstraints(), deviceId: { exact: physicalInput.deviceId } },
      });
      stopStream(microphone);
      microphone = physicalMicrophone;
    }
    if (this.#closed) {
      stopStream(microphone);
      return;
    }
    this.#microphone = microphone;
    for (const track of microphone.getAudioTracks()) track.contentHint = "speech";

    const peer = new RTCPeerConnection();
    this.#peer = peer;
    for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
    const channel = peer.createDataChannel("oai-events");
    this.#channel = channel;
    peer.addEventListener("track", (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      const speaker = this.#speaker
        ?? new SpeakerPlayback(new Audio(), this.#options.onStatus);
      this.#speaker = speaker;
      speaker.attach(stream);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
        this.#options.onStatus(`Voice ${peer.connectionState}`);
      }
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIce(peer);
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("the browser did not produce a Realtime WebRTC offer");
    const call = new AbortController();
    this.#call = call;
    const response = await fetch(this.#options.callUrl ?? "/api/realtime/calls", {
      method: "POST",
      signal: call.signal,
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-nanocodex-request": "1",
      },
      body: JSON.stringify({
        sdp,
        session_id: this.#options.sessionId,
        ...(startupContext ? { startup_context: startupContext } : {}),
        voice: this.#options.voice,
      }),
    });
    if (!response.ok) throw new Error(await responseError(response, "voice connection failed"));
    const callId = response.headers.get("x-nanocodex-realtime-call-id");
    if (!callId) throw new Error("voice connection did not return a Realtime call ID");
    const answer = await response.text();
    if (this.#closed || peer.signalingState === "closed") {
      return;
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
    if (this.#closed) return;
    const sideband = new WebSocket(String(
      this.#options.sidebandUrl?.(callId, this.#options.sessionId)
        ?? realtimeSidebandUrl(callId, this.#options.sessionId),
    ));
    this.#sideband = sideband;
    sideband.addEventListener("message", (event) => this.#onRealtimeMessage(event.data));
    sideband.addEventListener("close", () => {
      if (!this.#closed) {
        void this.close().catch((error) => {
          this.#options.onStatus(`Voice: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
    await waitForWebSocket(sideband);
    if (!this.#closed) {
      this.#options.onStatus(`Voice active (${this.#options.voice}) — /voice off to stop`);
    }
  }

  observe(message: WebTuiMessage): void {
    if (this.#closed || message.type !== "event" || !sameTarget(message.target, this.target)) return;
    const event = message.event;
    if (event.type === "run.started") {
      this.#streamedThisMessage = false;
      this.#outputSentThisRun = false;
      this.#runError = undefined;
      this.#output = new HandoffStream();
      return;
    }
    if (event.type === "assistant.delta") {
      const text = payloadText(event);
      if (text) {
        this.#streamedThisMessage = true;
        this.#output.pushText(text);
        this.#scheduleFlush();
      }
      return;
    }
    if (event.type === "assistant.message") {
      const text = payloadText(event);
      if (text && !this.#streamedThisMessage) this.#output.pushText(text);
      this.#flushOutput(true);
      this.#output = new HandoffStream();
      this.#streamedThisMessage = false;
      return;
    }
    if (event.type === "run.error") {
      this.#runError = payloadText(event) || "The coding agent failed.";
      return;
    }
    if (event.type === "run.completed" || event.type === "run.failed") {
      this.#flushOutput(true);
      if (event.type === "run.failed" && this.#activeDelegation && !this.#outputSentThisRun) {
        this.#sendOutput(this.#runError ?? "The coding agent failed.");
      }
      this.#output = new HandoffStream();
      this.#activeDelegation = undefined;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#stopMedia();
    this.#options.onStatus("Voice stopped");
    const tail = this.#transcript.splice(0).filter(({ text }) => text.trim());
    this.#closePromise = this.#finishLifecycle(tail);
    return this.#closePromise;
  }

  /** Releases browser resources after the owning agent disappears without messaging that agent again. */
  abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopMedia();
    this.#transcript = [];
    this.#closePromise = Promise.resolve();
  }

  #stopMedia(): void {
    this.#call?.abort();
    this.#call = undefined;
    if (this.#flushTimer !== undefined) window.clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    this.#output = new HandoffStream();
    if (this.#sideband?.readyState === WebSocket.OPEN) {
      this.#sideband.send(JSON.stringify({ type: "session.close" }));
    }
    this.#sideband?.close();
    this.#channel?.close();
    this.#peer?.close();
    stopStream(this.#microphone);
    this.#speaker?.close();
  }

  async #finishLifecycle(tail: VoiceTranscriptEntry[]): Promise<void> {
    if (!this.#lifecycleStart) return;
    try {
      await this.#lifecycleStart;
    } catch {
      return;
    }
    if (tail.length) this.#options.onDelegation({ kind: "tail", transcript: tail });
    await this.#options.onStop();
  }

  #onRealtimeMessage(payload: unknown): void {
    if (typeof payload !== "string") return;
    let event: Record<string, unknown>;
    try {
      const decoded = JSON.parse(payload);
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return;
      event = decoded as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type === "error") {
      const error = asRecord(event.error);
      const status = typeof error?.message === "string" ? `Voice: ${error.message}` : "Voice failed";
      void this.close().then(
        () => this.#options.onStatus(status),
        () => this.#options.onStatus(status),
      );
      return;
    }
    if (event.type === "input_audio_buffer.speech_started" || event.type === "speech_started") {
      this.#newInputEntry = true;
      return;
    }
    if (event.type === "response.created" || event.type === "response.started") {
      this.#newOutputEntry = true;
      return;
    }
    if (event.type === "input_transcript.added" || event.type === "output_transcript.added") {
      const item = asRecord(event.item);
      const text = typeof item?.text === "string" ? item.text : "";
      const role = event.type === "input_transcript.added" ? "user" : "assistant";
      if (text) {
        this.#appendTranscript(role, text, role === "user" ? this.#newInputEntry : this.#newOutputEntry);
        if (role === "user") {
          this.#newInputEntry = false;
          this.#options.onStatus(`Voice active (${this.#options.voice}) — hearing you…`);
        } else {
          this.#newOutputEntry = false;
        }
      }
      return;
    }
    if (event.type === "turn.done") {
      const turn = asRecord(event.turn);
      const role = turn?.role;
      const text = typeof turn?.transcript === "string" ? turn.transcript.trim() : "";
      if ((role === "user" || role === "assistant") && text) {
        this.#applyCompletedTranscript(role, text, role === "user" ? this.#newInputEntry : this.#newOutputEntry);
        if (role === "user") this.#newInputEntry = false;
        else this.#newOutputEntry = false;
        this.#options.onTranscript(role, text);
      }
      return;
    }
    if (event.type !== "delegation.created") return;
    const item = asRecord(event.item);
    if (item?.type !== "delegation" || item.target !== "client" || typeof item.id !== "string") return;
    const content = Array.isArray(item.content) ? item.content : [];
    const prompt = content
      .map(asRecord)
      .filter((part) => part?.type === "input_text" && typeof part.text === "string")
      .map((part) => String(part?.text))
      .join("")
      .trim();
    if (!prompt) return;
    this.#activeDelegation = item.id;
    if (!this.#transcript.some(({ role, text }) => role === "user" && text.trim() === prompt)) {
      this.#transcript.push({ role: "user", text: prompt });
    }
    const transcript = this.#transcript.splice(0);
    this.#newInputEntry = true;
    this.#newOutputEntry = true;
    this.#options.onDelegation({ kind: "request", input: prompt, transcript });
  }

  #appendTranscript(role: "user" | "assistant", text: string, forceNew: boolean): void {
    const last = this.#transcript.at(-1);
    if (!forceNew && last?.role === role) last.text += text;
    else this.#transcript.push({ role, text });
  }

  #applyCompletedTranscript(role: "user" | "assistant", text: string, forceNew: boolean): void {
    const last = this.#transcript.at(-1);
    if (!forceNew && last?.role === role) last.text = text;
    else this.#transcript.push({ role, text });
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = window.setTimeout(() => {
      this.#flushTimer = undefined;
      this.#flushOutput(false);
    }, OUTPUT_FLUSH_MS);
  }

  #flushOutput(final: boolean): void {
    if (this.#flushTimer !== undefined) window.clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    if (this.#sideband?.readyState !== WebSocket.OPEN) return;
    const output = final ? this.#output.drainFinalChunk() : this.#output.drainStreamChunk();
    if (!output) return;
    this.#sendOutput(output);
  }

  #sendOutput(output: string): void {
    if (this.#sideband?.readyState !== WebSocket.OPEN) return;
    this.#outputSentThisRun = true;
    for (const text of byteChunks(`[BACKEND] ${output}`, MAX_CONTEXT_APPEND_BYTES)) {
      this.#sideband.send(JSON.stringify(this.#activeDelegation
        ? {
            type: "delegation.context.append",
            delegation_item_id: this.#activeDelegation,
            content: [{ type: "input_text", text }],
          }
        : {
            type: "session.context.append",
            content: [{ type: "input_text", text }],
          }));
    }
  }

}

export function parseVoiceArgument(argument: string | undefined):
  | { action: "toggle" | "stop" | "list" }
  | { action: "start"; voice: ChatGptVoice }
  | { action: "invalid"; message: string } {
  const normalized = argument?.trim().toLowerCase();
  if (!normalized) return { action: "toggle" };
  if (normalized === "off") return { action: "stop" };
  if (normalized === "list") return { action: "list" };
  if (normalized === "on") return { action: "start", voice: "cove" };
  if ((CHATGPT_VOICES as readonly string[]).includes(normalized)) {
    return { action: "start", voice: normalized as ChatGptVoice };
  }
  return { action: "invalid", message: "Unknown voice. Use /voice list to see ChatGPT voices." };
}

function payloadText(event: AgentEvent): string {
  if (typeof event.payload.text === "string") return event.payload.text;
  return typeof event.payload.message === "string" ? event.payload.message : "";
}

function byteChunks(value: string, size: number): string[] {
  const encoder = new TextEncoder();
  const result: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (chunk && bytes + characterBytes > size) {
      result.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk) result.push(chunk);
  return result;
}

export class HandoffStream {
  #sentBytes = 0;
  #bufferedText = "";
  #tailText = "";
  #truncated = false;

  get hasOutput(): boolean {
    return this.#sentBytes > 0 || Boolean(this.#bufferedText || this.#tailText);
  }

  pushText(text: string): void {
    if (!text) return;
    if (this.#truncated) {
      this.#tailText = takeLastBytes(this.#tailText + text, this.#tailByteLimit());
      return;
    }
    this.#bufferedText += text;
    const remaining = REALTIME_OUTPUT_BYTE_LIMIT - this.#sentBytes;
    if (utf8Bytes(this.#bufferedText) <= remaining) return;
    this.#tailText = takeLastBytes(this.#bufferedText, this.#tailByteLimit());
    this.#bufferedText = takeFirstBytes(this.#bufferedText, this.#streamableTextBytes());
    this.#truncated = true;
  }

  drainStreamChunk(): string | undefined {
    const text = takeFirstBytes(this.#bufferedText, this.#streamableTextBytes());
    if (!text) return undefined;
    this.#bufferedText = this.#bufferedText.slice(text.length);
    this.#sentBytes += utf8Bytes(text);
    return text;
  }

  drainFinalChunk(): string | undefined {
    if (!this.#truncated) {
      if (!this.#bufferedText) return undefined;
      const text = this.#bufferedText;
      this.#bufferedText = "";
      this.#sentBytes += utf8Bytes(text);
      return text;
    }
    const text = `${this.#bufferedText}${HANDOFF_STREAM_TRUNCATION_MARKER}${this.#tailText}`;
    this.#bufferedText = "";
    this.#tailText = "";
    this.#sentBytes += utf8Bytes(text);
    return text;
  }

  #streamHeadByteLimit(): number {
    return Math.floor(
      (REALTIME_OUTPUT_BYTE_LIMIT - utf8Bytes(HANDOFF_STREAM_TRUNCATION_MARKER)) / 2,
    );
  }

  #tailByteLimit(): number {
    return REALTIME_OUTPUT_BYTE_LIMIT
      - this.#streamHeadByteLimit()
      - utf8Bytes(HANDOFF_STREAM_TRUNCATION_MARKER);
  }

  #streamableTextBytes(): number {
    return Math.max(0, this.#streamHeadByteLimit() - this.#sentBytes);
  }
}

function takeFirstBytes(text: string, maximum: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const next = utf8Bytes(character);
    if (bytes + next > maximum) break;
    bytes += next;
    end += character.length;
  }
  return text.slice(0, end);
}

function takeLastBytes(text: string, maximum: number): string {
  let bytes = 0;
  let start = text.length;
  const characters = [...text];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const next = utf8Bytes(character);
    if (bytes + next > maximum) break;
    bytes += next;
    start -= character.length;
  }
  return text.slice(start);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sameTarget(left: TuiTarget, right: TuiTarget): boolean {
  return left.pane === right.pane
    && (left.pane === "main"
      ? right.pane === "main" && left.branchId === right.branchId
      : right.pane === "btw" && left.id === right.id);
}

function stopStream(stream: MediaStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function voiceAudioConstraints(): MediaTrackConstraints {
  return {
    autoGainControl: true,
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression: true,
  };
}

async function captureMicrophone(constraints: MediaStreamConstraints): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === "NotAllowedError" || error.name === "SecurityError") {
        throw new Error(
          "microphone permission denied; allow microphone access for this site and retry",
          { cause: error },
        );
      }
      if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        throw new Error("no microphone is available", { cause: error });
      }
      if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        throw new Error("the microphone is busy or unavailable", { cause: error });
      }
    }
    throw error;
  }
}

export function preferredPhysicalInput(
  devices: readonly MediaDeviceInfo[],
  currentLabel: string | undefined,
): MediaDeviceInfo | undefined {
  if (!currentLabel || !isVirtualAudioInput(currentLabel)) return undefined;
  const inputs = devices.filter((device) =>
    device.kind === "audioinput"
    && device.deviceId !== "default"
    && device.deviceId !== "communications"
    && Boolean(device.label)
    && !isVirtualAudioInput(device.label)
  );
  return inputs.find((device) => /built-in|macbook|internal/i.test(device.label)) ?? inputs[0];
}

function isVirtualAudioInput(label: string): boolean {
  return /blackhole|soundflower|loopback|vb-audio|virtual|background music/i.test(label);
}

async function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("voice ICE gathering timed out")), 15_000);
    const changed = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      error ? reject(error) : resolve();
    };
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

async function waitForWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("voice sideband timed out")), 15_000);
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("error", failed);
      error ? reject(error) : resolve();
    };
    const opened = () => finish();
    const closed = () => finish(new Error("voice sideband closed during startup"));
    const failed = () => finish(new Error("voice sideband failed during startup"));
    socket.addEventListener("open", opened);
    socket.addEventListener("close", closed);
    socket.addEventListener("error", failed);
  });
}

function realtimeSidebandUrl(callId: string, sessionId: string): string {
  const url = new URL("/api/realtime/sideband", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("call_id", callId);
  url.searchParams.set("session_id", sessionId);
  return url.href;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = (await response.text()).slice(0, 4_096);
  try {
    const error = asRecord(JSON.parse(body))?.error;
    return typeof error === "string" ? error : `${fallback}: HTTP ${response.status}`;
  } catch {
    return body || `${fallback}: HTTP ${response.status}`;
  }
}
