import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  MULTIPLAYER_MAX_MESSAGE_BYTES,
  MultiplayerProtocolError,
  createMultiplayerRoomState,
  decodeMultiplayerMessage,
  multiplayerInvitation,
  multiplayerInviteUrl,
  multiplayerRoomPath,
  multiplayerSocketUrl,
  reduceMultiplayerMessage,
  type MultiplayerAuthMode,
  type MultiplayerRoomState,
  type MultiplayerTarget,
} from "./multiplayerProtocol";
import "./Multiplayer.css";

type LobbyState =
  | { kind: "create"; error?: string }
  | { kind: "join"; roomId: string; invite: string; error?: string }
  | { kind: "resume"; roomId: string }
  | { kind: "blocked"; roomId: string; error: string };

type RoomReceipt = {
  roomId: string;
  memberId: string;
  authMode: MultiplayerAuthMode;
  invite?: string;
};

type PendingRoom = Omit<RoomReceipt, "memberId"> & { memberId?: string; inviteUrl?: string };

const encoder = new TextEncoder();
const RECONNECT_DELAYS = [500, 1_000, 2_000, 4_000, 8_000];

export function Multiplayer() {
  const initial = useRef(multiplayerInvitation(new URL(window.location.href))).current;
  const [lobby, setLobby] = useState<LobbyState>(() => initial.roomId && initial.invite
    ? { kind: "join", roomId: initial.roomId, invite: initial.invite }
    : initial.roomId
      ? { kind: "resume", roomId: initial.roomId }
      : { kind: "create" });
  const [displayName, setDisplayName] = useState(readDisplayName);
  const [pending, setPending] = useState(false);
  const [room, setRoom] = useState<MultiplayerRoomState>();
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<MultiplayerTarget>("room");
  const [roomError, setRoomError] = useState<string>();
  const [inviteCopied, setInviteCopied] = useState(false);
  const [endingRoom, setEndingRoom] = useState(false);
  const roomRef = useRef<MultiplayerRoomState | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const socketGeneration = useRef(0);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const reconnectAttempt = useRef(0);
  const pendingRoomRef = useRef<PendingRoom | undefined>(undefined);
  const mounted = useRef(true);
  const lifecycleAbort = useRef(new AbortController());
  const transcriptRef = useRef<HTMLOListElement>(null);

  const commitRoom = useCallback((next: MultiplayerRoomState) => {
    roomRef.current = next;
    setRoom(next);
  }, []);

  const connect = useCallback((receipt: PendingRoom, isReconnect = false) => {
    if (!mounted.current) return;
    window.clearTimeout(reconnectTimer.current);
    const generation = ++socketGeneration.current;
    socketRef.current?.close(1000, "replaced connection");
    const retained = roomRef.current?.roomId === receipt.roomId ? roomRef.current : undefined;
    const cursor = retained?.cursor ?? "0";
    const socket = new WebSocket(multiplayerSocketUrl(window.location.origin, receipt.roomId, cursor));
    socketRef.current = socket;
    pendingRoomRef.current = receipt;

    socket.addEventListener("message", (event) => {
      if (!mounted.current
        || generation !== socketGeneration.current
        || typeof event.data !== "string") return;
      try {
        const message = decodeMultiplayerMessage(event.data);
        if (message.type === "ready") {
          if (message.room_id !== receipt.roomId
            || (receipt.memberId !== undefined && message.member_id !== receipt.memberId)) {
            throw new MultiplayerProtocolError("room membership identity changed");
          }
          const current = roomRef.current?.roomId === receipt.roomId
            ? reduceMultiplayerMessage(roomRef.current, message)
            : createMultiplayerRoomState(message, { inviteUrl: receipt.inviteUrl });
          commitRoom(current);
          setLobby({ kind: "resume", roomId: receipt.roomId });
          setPending(false);
          setConnected(true);
          setRoomError(undefined);
          reconnectAttempt.current = 0;
          window.history.replaceState(window.history.state, "", multiplayerRoomPath(receipt.roomId));
          return;
        }
        const current = roomRef.current;
        if (!current || current.roomId !== receipt.roomId) return;
        if (message.type === "replay_paused") {
          const next = reduceMultiplayerMessage(current, message);
          commitRoom(next);
          socket.send(JSON.stringify({ type: "ack", cursor: message.cursor }));
          return;
        }
        if (message.type === "error") {
          setRoomError(roomOperationError(message.code));
          return;
        }
        commitRoom(reduceMultiplayerMessage(current, message));
      } catch {
        setRoomError("The room stream was invalid. Reconnect to replay its last durable cursor.");
        socket.close(1002, "invalid room protocol");
      }
    });

    socket.addEventListener("close", () => {
      if (!mounted.current || generation !== socketGeneration.current) return;
      setConnected(false);
      if (!roomRef.current || roomRef.current.roomId !== receipt.roomId) {
        setPending(false);
        setLobby({
          kind: "blocked",
          roomId: receipt.roomId,
          error: "The room connection failed. Retry with this browser's membership cookie or use the original invite link.",
        });
        return;
      }
      const attempt = reconnectAttempt.current++;
      if (attempt > 0) {
        setRoomError("The room connection was interrupted. Durable messages are retained; reconnecting is automatic.");
      }
      reconnectTimer.current = window.setTimeout(
        () => connect(receipt, true),
        RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)],
      );
    });

    socket.addEventListener("error", () => {
      if (!mounted.current || generation !== socketGeneration.current) return;
      if (!isReconnect && !roomRef.current) {
        setRoomError(undefined);
      }
    });
  }, [commitRoom]);

  useEffect(() => {
    mounted.current = true;
    if (lifecycleAbort.current.signal.aborted) {
      lifecycleAbort.current = new AbortController();
    }
    return () => {
      mounted.current = false;
      lifecycleAbort.current.abort();
      socketGeneration.current++;
      window.clearTimeout(reconnectTimer.current);
      socketRef.current?.close(1000, "surface closed");
    };
  }, []);

  useEffect(() => {
    if (lobby.kind !== "resume" || roomRef.current?.roomId === lobby.roomId) return;
    const controller = new AbortController();
    void fetch(`/v1/rooms/${lobby.roomId}`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("membership_missing");
      const state = await response.json<unknown>();
      const decoded = decodeRoomState(state, lobby.roomId);
      const receipt: PendingRoom = {
        roomId: lobby.roomId,
        authMode: decoded.authMode,
      };
      connect(receipt);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setPending(false);
      setLobby({
        kind: "blocked",
        roomId: lobby.roomId,
        error: error instanceof Error && error.message === "membership_missing"
          ? "This browser has no membership for the room. Open its original invite link to join."
          : "The room could not be opened. Check the managed Multiplayer deployment and retry.",
      });
    });
    return () => controller.abort();
  }, [connect, lobby]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 25_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [room?.cursor]);

  useEffect(() => {
    if (room && !room.canTargetAgent && target === "agent") setTarget("room");
  }, [room, target]);

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    const signal = lifecycleAbort.current.signal;
    const name = displayName.trim();
    if (!name) {
      setLobby({ kind: "create", error: "Enter a display name." });
      return;
    }
    setPending(true);
    setLobby({ kind: "create" });
    try {
      const response = await fetch("/v1/rooms", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ display_name: name }),
        signal,
      });
      if (!response.ok) throw new Error(createRoomError(response.status));
      const receipt = decodeRoomReceipt(await response.json<unknown>(), true);
      if (signal.aborted || !mounted.current) return;
      writeDisplayName(name);
      const inviteUrl = multiplayerInviteUrl(window.location.origin, receipt.roomId, receipt.invite!);
      window.history.replaceState(window.history.state, "", multiplayerRoomPath(receipt.roomId));
      connect({ ...receipt, inviteUrl });
    } catch (error) {
      if (signal.aborted || !mounted.current) return;
      setPending(false);
      setLobby({
        kind: "create",
        error: error instanceof Error ? error.message : "The room could not be created.",
      });
    }
  };

  const joinRoom = async (event: FormEvent) => {
    event.preventDefault();
    if (lobby.kind !== "join") return;
    const signal = lifecycleAbort.current.signal;
    const name = displayName.trim();
    if (!name) {
      setLobby({ ...lobby, error: "Enter a display name." });
      return;
    }
    setPending(true);
    setLobby({ ...lobby, error: undefined });
    try {
      const response = await fetch(`/v1/rooms/${lobby.roomId}/join`, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ invite: lobby.invite, display_name: name }),
        signal,
      });
      if (!response.ok) throw new Error(joinRoomError(response.status));
      const receipt = decodeRoomReceipt(await response.json<unknown>(), false);
      if (signal.aborted || !mounted.current) return;
      writeDisplayName(name);
      window.history.replaceState(window.history.state, "", multiplayerRoomPath(receipt.roomId));
      connect(receipt);
    } catch (error) {
      if (signal.aborted || !mounted.current) return;
      setPending(false);
      setLobby({
        ...lobby,
        error: error instanceof Error ? error.message : "The room could not be joined.",
      });
    }
  };

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (target === "agent" && !roomRef.current?.canTargetAgent) {
      setRoomError("Only the room host can ask the managed agent.");
      setTarget("room");
      return;
    }
    if (encoder.encode(text).byteLength > MULTIPLAYER_MAX_MESSAGE_BYTES) {
      setRoomError("Messages must be no larger than 16 KiB.");
      return;
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setRoomError("The room is offline. Retry the connection before sending.");
      return;
    }
    socket.send(JSON.stringify({
      type: "say",
      id: `message-${crypto.randomUUID()}`,
      text,
      target,
    }));
    setDraft("");
    setRoomError(undefined);
  };

  const handleComposerKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const retryRoom = () => {
    const receipt = pendingRoomRef.current;
    if (!receipt) {
      if (lobby.kind === "blocked") setLobby({ kind: "resume", roomId: lobby.roomId });
      return;
    }
    setRoomError(undefined);
    connect(receipt, true);
  };

  const leaveRoom = () => {
    socketGeneration.current++;
    window.clearTimeout(reconnectTimer.current);
    socketRef.current?.close(1000, "left room");
    socketRef.current = undefined;
    setConnected(false);
    roomRef.current = undefined;
    pendingRoomRef.current = undefined;
    setRoom(undefined);
    setRoomError(undefined);
    setLobby({ kind: "create" });
    window.history.replaceState(window.history.state, "", multiplayerRoomPath());
  };

  const endRoom = async () => {
    if (!room?.canTargetAgent || endingRoom) return;
    setEndingRoom(true);
    try {
      const response = await fetch(`/v1/rooms/${room.roomId}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (response.status !== 204 && response.status !== 404) {
        throw new Error("room_cleanup_pending");
      }
      leaveRoom();
    } catch {
      setRoomError("The room could not be ended yet. Its durable cleanup owner will keep retrying; try again shortly.");
    } finally {
      if (mounted.current) setEndingRoom(false);
    }
  };

  const copyInvite = () => {
    if (!room?.inviteUrl) return;
    void navigator.clipboard.writeText(room.inviteUrl).then(() => {
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 1_500);
    });
  };

  if (!room && lobby.kind === "resume") return null;

  if (!room) {
    return (
      <section className="multiplayer-lobby" aria-labelledby="multiplayer-title">
        <header className="multiplayer-heading">
          <div>
            <p>durable multiplayer</p>
            <h1 id="multiplayer-title">One room. Many humans. One managed agent.</h1>
          </div>
          <span>Cloudflare Durable Objects</span>
        </header>

        <div className="multiplayer-lobby-grid">
          <article className="multiplayer-lobby-card">
            {lobby.kind === "join" ? (
              <form onSubmit={joinRoom}>
                <p className="multiplayer-kicker">room invitation · {shortRoomId(lobby.roomId)}</p>
                <h2>Join the room</h2>
                <label>
                  <span>Display name</span>
                  <input
                    autoComplete="nickname"
                    maxLength={64}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
                {lobby.error ? <p className="multiplayer-error" role="alert">{lobby.error}</p> : null}
                <button type="submit" disabled={pending}>Join room</button>
              </form>
            ) : lobby.kind === "blocked" ? (
              <div className="multiplayer-blocked">
                <p className="multiplayer-kicker">room · {shortRoomId(lobby.roomId)}</p>
                <h2>Membership required</h2>
                <p className="multiplayer-error" role="alert">{lobby.error}</p>
                <div className="multiplayer-button-row">
                  <button type="button" onClick={retryRoom}>Retry</button>
                  <button type="button" onClick={leaveRoom}>Create another room</button>
                </div>
              </div>
            ) : lobby.kind === "create" ? (
              <form onSubmit={createRoom}>
                <p className="multiplayer-kicker">host a session</p>
                <h2>Create a room</h2>
                <label>
                  <span>Display name</span>
                  <input
                    autoComplete="nickname"
                    maxLength={64}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
                <p className="multiplayer-form-note">
                  Room allocation is authorized server-side. No deployment or provider credential enters this page.
                </p>
                {lobby.error ? <p className="multiplayer-error" role="alert">{lobby.error}</p> : null}
                <button type="submit" disabled={pending}>Create room</button>
              </form>
            ) : null}
          </article>

          <aside className="multiplayer-boundary" aria-label="Multiplayer architecture">
            <div>
              <span>01</span>
              <h2>Room</h2>
              <p>One SQLite Durable Object commits membership, chat order, replay cursors, and the agent outbox.</p>
            </div>
            <div>
              <span>02</span>
              <h2>Agent</h2>
              <p>One private, tool-free managed agent retains WASM history. Only the host can admit a metered turn.</p>
            </div>
            <div>
              <span>03</span>
              <h2>Broker</h2>
              <p>A private Worker injects OAuth or API-key credentials only into an exact upstream WebSocket.</p>
            </div>
          </aside>
        </div>
      </section>
    );
  }

  const online = new Set(room.onlineMemberIds);
  return (
    <section className="multiplayer-room" aria-labelledby="multiplayer-room-title">
      <header className="multiplayer-room-heading">
        <div>
          <p>durable multiplayer · {shortRoomId(room.roomId)}</p>
          <h1 id="multiplayer-room-title">Managed-agent room</h1>
        </div>
        <div className="multiplayer-room-actions">
          <span className={connected ? "is-live" : ""}><i />{connected ? "live" : "offline"}</span>
          {room.inviteUrl ? (
            <button type="button" onClick={copyInvite}>{inviteCopied ? "Invite copied" : "Copy invite"}</button>
          ) : null}
          {room.canTargetAgent ? (
            <button type="button" disabled={endingRoom} onClick={() => void endRoom()}>End room</button>
          ) : null}
          <button type="button" onClick={leaveRoom}>Leave</button>
        </div>
      </header>

      <div className="multiplayer-room-grid">
        <div className="multiplayer-chat">
          <ol ref={transcriptRef} aria-live="polite" aria-label="Room transcript">
            {room.timeline.map((item) => (
              <TimelineItem
                key={item.cursor}
                item={item}
                ownMemberId={room.memberId}
              />
            ))}
          </ol>
          {roomError ? (
            <div className="multiplayer-room-error" role="alert">
              <span>{roomError}</span>
              {!connected ? <button type="button" onClick={retryRoom}>Retry</button> : null}
            </div>
          ) : null}
          <form className="multiplayer-composer" onSubmit={sendMessage}>
            <div className="multiplayer-target" aria-label="Message target">
              <button
                className={target === "room" ? "is-active" : ""}
                type="button"
                aria-pressed={target === "room"}
                onClick={() => setTarget("room")}
              >
                Room
              </button>
              {room.canTargetAgent ? (
                <button
                  className={target === "agent" ? "is-active" : ""}
                  type="button"
                  aria-pressed={target === "agent"}
                  onClick={() => setTarget("agent")}
                >
                  Ask agent
                </button>
              ) : null}
            </div>
            <textarea
              aria-label={target === "agent" ? "Message the room and ask Nanocodex" : "Message the room"}
              placeholder={target === "agent" ? "Ask Nanocodex in the shared room" : "Message everyone"}
              rows={3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKey}
              disabled={!connected}
            />
            <button type="submit" disabled={!connected || !draft.trim()}>Send</button>
          </form>
        </div>

        <aside className="multiplayer-sidebar">
          <section aria-labelledby="multiplayer-members-title">
            <header>
              <p>participants</p>
              <strong>{room.onlineMemberIds.length + 1} online</strong>
            </header>
            <h2 className="sr-only" id="multiplayer-members-title">Room participants</h2>
            <ul>
              <li className="is-online is-agent">
                <i />
                <span><strong>Nanocodex</strong><small>managed agent</small></span>
              </li>
              {room.members.map((member) => (
                <li className={online.has(member.id) ? "is-online" : ""} key={member.id}>
                  <i />
                  <span>
                    <strong>{member.name}{member.id === room.memberId ? " · you" : ""}</strong>
                    <small>{online.has(member.id) ? "in room" : "offline"}</small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="multiplayer-credential-boundary" aria-labelledby="credential-boundary-title">
            <header>
              <p>credential boundary</p>
              <strong>{room.authMode === "chatgpt" ? "OAuth" : "API key"}</strong>
            </header>
            <h2 id="credential-boundary-title">Secretless agent</h2>
            <p>
              The room and WASM agent send a fixed placeholder through a private Service Binding.
              The tool-free room profile cannot act outside chat; the broker replaces the placeholder
              only after exact destination and header checks.
            </p>
            <dl>
              <div><dt>Browser</dt><dd>room cookie</dd></div>
              <div><dt>Agent</dt><dd>placeholder</dd></div>
              <div><dt>Broker</dt><dd>{room.authMode === "chatgpt" ? "OAuth owner" : "API key"}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </section>
  );
}

function TimelineItem({
  item,
  ownMemberId,
}: {
  item: MultiplayerRoomState["timeline"][number];
  ownMemberId: string;
}) {
  const event = item.event;
  if (event.type === "member_joined") {
    return <li className="multiplayer-system"><span>{event.member.name} joined the room</span></li>;
  }
  if (event.type === "agent_error") {
    const message = event.code === "rate_limited"
      ? "The deployment-wide managed-agent budget is temporarily exhausted."
      : `Nanocodex could not complete that room turn (${event.code}).`;
    return (
      <li className="multiplayer-system is-error">
        <span>{message}</span>
      </li>
    );
  }
  const agent = event.type === "agent_message";
  const own = event.type === "member_message" && event.member.id === ownMemberId;
  const name = agent ? "Nanocodex" : event.member.name;
  const text = event.text;
  return (
    <li className={`multiplayer-message${agent ? " is-agent" : ""}${own ? " is-own" : ""}`}>
      <header>
        <strong>{name}</strong>
        {event.type === "member_message" && event.target === "agent" ? <span>asked agent</span> : null}
        <time dateTime={new Date(item.createdAt).toISOString()}>{formatTime(item.createdAt)}</time>
      </header>
      <p>{text}</p>
    </li>
  );
}

function decodeRoomReceipt(value: unknown, creator: boolean): RoomReceipt {
  const receipt = asRecord(value);
  const roomId = receipt?.room_id;
  const memberId = receipt?.member_id;
  const authMode = receipt?.auth_mode;
  const invite = receipt?.invite;
  if (typeof roomId !== "string" || typeof memberId !== "string"
    || (authMode !== "api_key" && authMode !== "chatgpt")
    || (creator && typeof invite !== "string")) {
    throw new Error("The room returned an invalid creation receipt.");
  }
  multiplayerSocketUrl(window.location.origin, roomId, "0");
  return {
    roomId,
    memberId,
    authMode,
    ...(typeof invite === "string" ? { invite } : {}),
  };
}

function decodeRoomState(value: unknown, roomId: string): { authMode: MultiplayerAuthMode } {
  const state = asRecord(value);
  if (state?.room_id !== roomId || (state.auth_mode !== "api_key" && state.auth_mode !== "chatgpt")) {
    throw new Error("invalid_room_state");
  }
  // The authenticated state route deliberately omits member identity. The
  // hibernatable socket returns it after validating the HttpOnly room cookie.
  return { authMode: state.auth_mode };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function createRoomError(status: number): string {
  if (status === 401) return "The deployment rejected room allocation.";
  if (status === 429) return "Room creation is temporarily limited. Try again later.";
  if (status === 503) return "The managed Multiplayer deployment is unavailable.";
  return "The room could not be created.";
}

function joinRoomError(status: number): string {
  if (status === 401) return "This invite is invalid or no longer available.";
  if (status === 404) return "This room is no longer available.";
  if (status === 429) return "This room has reached its member limit.";
  return "The room could not be joined.";
}

function roomOperationError(code: string): string {
  if (code === "agent_queue_full") return "The managed agent queue is full. Let its current room turns finish first.";
  if (code === "owner_required" || code === "agent_owner_required") {
    return "Only the room host can ask the managed agent.";
  }
  if (code === "agent_rate_limited") return "The room's managed-agent budget is temporarily exhausted.";
  if (code === "agent_capacity_unavailable") return "The deployment-wide managed-agent budget is temporarily unavailable.";
  if (code === "chat_rate_limited") return "Room chat is temporarily rate limited. Wait before sending again.";
  if (code === "message_id_conflict") return "That message conflicted with an earlier durable receipt. Send it again.";
  if (code === "event_log_full") return "This demo room reached its durable event capacity. Create another room.";
  return "The room rejected that operation. Review the message and try again.";
}

function readDisplayName(): string {
  try {
    return localStorage.getItem("nanocodex-multiplayer-name") ?? "";
  } catch {
    return "";
  }
}

function writeDisplayName(name: string): void {
  try {
    localStorage.setItem("nanocodex-multiplayer-name", name);
  } catch {
    // A display name is optional convenience state, never a room capability.
  }
}

function shortRoomId(roomId: string): string {
  return roomId.slice(0, 8);
}

function formatTime(createdAt: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(createdAt);
}
