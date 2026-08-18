import type { AgentEvent, TuiTarget } from "nanocodex-tui";

import type { WebTuiMessage } from "./nanocodex";

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

type TranscriptEntry = { role: "user" | "assistant"; text: string };

export type BrowserVoiceOptions = {
  sessionId: string;
  target: TuiTarget;
  voice: ChatGptVoice;
  onDelegation(prompt: string): void;
  onStatus(status: string): void;
  onTranscript(speaker: "user" | "assistant", text: string): void;
};

const MAX_CONTEXT_APPEND_BYTES = 500;
const OUTPUT_FLUSH_MS = 200;

/** Main-thread browser media and ChatGPT Realtime lifecycle. */
export class BrowserVoiceSession {
  readonly #options: BrowserVoiceOptions;
  #peer?: RTCPeerConnection;
  #channel?: RTCDataChannel;
  #sideband?: WebSocket;
  #microphone?: MediaStream;
  #speaker?: HTMLAudioElement;
  #call?: AbortController;
  #transcript: TranscriptEntry[] = [];
  #newInputEntry = false;
  #newOutputEntry = false;
  #activeDelegation?: string;
  #output = "";
  #flushTimer?: number;
  #streamedThisRun = false;
  #closed = false;

  constructor(options: BrowserVoiceOptions) {
    this.#options = options;
  }

  get target(): TuiTarget {
    return this.#options.target;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("this browser does not expose microphone capture");
    }
    this.#options.onStatus("Connecting voice…");
    let microphone = await navigator.mediaDevices.getUserMedia({ audio: voiceAudioConstraints() });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const initialTrack = microphone.getAudioTracks()[0];
    const physicalInput = preferredPhysicalInput(devices, initialTrack?.label);
    if (initialTrack && isVirtualAudioInput(initialTrack.label) && physicalInput) {
      const physicalMicrophone = await navigator.mediaDevices.getUserMedia({
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
      const speaker = this.#speaker ?? new Audio();
      speaker.autoplay = true;
      speaker.srcObject = stream;
      this.#speaker = speaker;
      void speaker.play().catch(() => {
        this.#options.onStatus("Voice connected — click the page once to enable speaker audio");
      });
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
    const response = await fetch("/api/realtime/calls", {
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
    const sideband = new WebSocket(realtimeSidebandUrl(callId, this.#options.sessionId));
    this.#sideband = sideband;
    sideband.addEventListener("message", (event) => this.#onRealtimeMessage(event.data));
    sideband.addEventListener("close", () => {
      if (!this.#closed) this.#options.onStatus("Voice stopped");
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
      this.#streamedThisRun = false;
      return;
    }
    if (event.type === "assistant.delta") {
      const text = payloadText(event);
      if (text) {
        this.#streamedThisRun = true;
        this.#output += text;
        this.#scheduleFlush();
      }
      return;
    }
    if (event.type === "assistant.message" && !this.#streamedThisRun) {
      const text = payloadText(event);
      if (text) {
        this.#output += text;
        this.#flushOutput();
      }
      return;
    }
    if (event.type === "run.completed" || event.type === "run.failed") {
      this.#flushOutput();
      this.#activeDelegation = undefined;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#call?.abort();
    this.#call = undefined;
    if (this.#flushTimer !== undefined) window.clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    this.#output = "";
    if (this.#sideband?.readyState === WebSocket.OPEN) {
      this.#sideband.send(JSON.stringify({ type: "session.close" }));
    }
    this.#sideband?.close();
    this.#channel?.close();
    this.#peer?.close();
    stopStream(this.#microphone);
    if (this.#speaker) {
      this.#speaker.pause();
      this.#speaker.srcObject = null;
    }
    this.#options.onStatus("Voice stopped");
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
      this.#options.onStatus(typeof error?.message === "string" ? `Voice: ${error.message}` : "Voice failed");
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
    this.#options.onDelegation(realtimeDelegation(prompt, transcript));
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
      this.#flushOutput();
    }, OUTPUT_FLUSH_MS);
  }

  #flushOutput(): void {
    if (this.#flushTimer !== undefined) window.clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    const output = this.#output;
    this.#output = "";
    if (!output || this.#sideband?.readyState !== WebSocket.OPEN) return;
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
  return typeof event.payload.text === "string" ? event.payload.text : "";
}

function realtimeDelegation(input: string, transcript: readonly TranscriptEntry[]): string {
  const delta = transcript.map(({ role, text }) => `${role}: ${text}`).join("\n");
  return delta
    ? `<realtime_delegation>\n  <input>${escapeXml(input)}</input>\n  <transcript_delta>${escapeXml(delta)}</transcript_delta>\n</realtime_delegation>`
    : `<realtime_delegation>\n  <input>${escapeXml(input)}</input>\n</realtime_delegation>`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
