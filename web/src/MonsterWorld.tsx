import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AgentStatus } from "./agentTerminalTypes";
import {
  AgentSessionBar,
  type ChatGptStatus,
  type CredentialSource,
} from "./chatGptSession";
import {
  AUTONOMOUS_AGENT_IDS,
  RESIDENT_IDS,
  VOICE_LEVELS,
  VOICE_RADIUS,
  WORLD_PROTOCOL,
  isResidentId,
  isWorldAgentMessage,
  isWorldUsageLimitMessage,
  type Direction,
  type ResidentId,
  type VoiceLevel,
  type WorldAgentCommand,
  type WorldAgentMessage,
  type WorldBatchThinkEntry,
  type WorldFailureClass,
  type WorldUsage,
} from "./monsterWorldProtocol";
import {
  drawMonsterWorld,
  loadWorldAssets,
  type WorldAssets,
} from "./monsterWorldRenderer";
import {
  WORLD_PIXEL_HEIGHT,
  WORLD_PIXEL_WIDTH,
  sceneLabel,
  viewportToWorld,
} from "./monsterWorldMap";
import {
  WORLD_SAVE_KEY,
  MAX_RESIDENT_COUNT,
  activeResidentCount,
  actorWorldPosition,
  applyResidentMemory,
  applyWorldPlan,
  createWorldState,
  formatWorldTime,
  hasUnansweredGuildCall,
  hasUnansweredPlayerOrder,
  isGuildRelayActive,
  liveAgentIdsInWorld,
  movePlayer,
  observationFor,
  playerInteract,
  playerSpeak,
  requestResidentExit,
  residentMemoryFor,
  residentAtWorldPoint,
  serializeWorldState,
  setPopulationTarget,
  setWorldAgentsOnline,
  updateWorld,
  worldCameraForState,
  type WorldActor,
  type WorldState,
} from "./monsterWorldSimulation";
import "./MonsterWorld.css";

const MAX_MODEL_BATCHES = 24;
const MAX_AGENT_TOKENS = 60_000;
const LUNA_LANE_COUNT = 3;
const MAX_RESIDENTS_PER_BATCH = 4;

type RuntimeStatus = "offline" | "starting" | "ready" | "blocked" | "error";

type UsageTotals = {
  modelBatches: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedUsd: number;
};

type PendingResidentRequest = Readonly<{
  requestId: string;
  batchId: string;
  agentId: ResidentId;
  lane: number;
}>;

type PendingBatch = {
  readonly batchId: string;
  readonly lane: number;
  readonly requests: readonly PendingResidentRequest[];
  usageCounted: boolean;
  resultReceived: boolean;
  readonly rejectedResidentIds: Set<ResidentId>;
};

const emptyUsage: UsageTotals = {
  modelBatches: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedUsd: 0,
};

export function MonsterWorld() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const assetsRef = useRef<WorldAssets | undefined>(undefined);
  const worldRef = useRef<WorldState | undefined>(undefined);
  const workerRef = useRef<Worker | undefined>(undefined);
  const heldDirections = useRef(new Set<Direction>());
  const pendingBatches = useRef(new Map<string, PendingBatch>());
  const pendingRequests = useRef(new Map<string, PendingResidentRequest>());
  const nextThinkAt = useRef(createThinkSchedule());
  const usageRef = useRef<UsageTotals>(emptyUsage);
  const runtimeStatusRef = useRef<RuntimeStatus>("offline");
  const [revision, setRevision] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [draft, setDraft] = useState("");
  const [voiceLevel, setVoiceLevel] = useState<VoiceLevel>("call");
  const [selectedResident, setSelectedResident] = useState<ResidentId>("cinder");
  const [speechNotice, setSpeechNotice] = useState<string>();
  const [latestOrderId, setLatestOrderId] = useState<number>();
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>("offline");
  const [agentError, setAgentError] = useState<string>();
  const [agentNotice, setAgentNotice] = useState<string>();
  const [, setAuthStatus] = useState<ChatGptStatus>();
  const [credentialSource, setCredentialSource] = useState<CredentialSource>();
  const [usage, setUsage] = useState<UsageTotals>(emptyUsage);
  const capabilityError = useMemo(worldCapabilityError, []);

  if (!worldRef.current) {
    worldRef.current = createWorldState(readSavedWorld());
  }
  const world = worldRef.current;

  useEffect(() => {
    runtimeStatusRef.current = runtimeStatus;
  }, [runtimeStatus]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let current = true;
    void loadWorldAssets().then((assets) => {
      if (current) assetsRef.current = assets;
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.imageSmoothingEnabled = false;
    let frame = 0;
    let previous = performance.now();
    let nextUiUpdate = previous;
    let nextSave = previous + 4_000;
    const render = (now: number) => {
      const delta = now - previous;
      previous = now;
      const activeWorld = worldRef.current;
      if (activeWorld && !paused && document.visibilityState === "visible") {
        const direction = heldDirections.current.values().next().value;
        if (direction) movePlayer(activeWorld, direction);
        updateWorld(activeWorld, delta);
      }
      if (activeWorld) {
        drawMonsterWorld(context, activeWorld, assetsRef.current, { reducedMotion });
        if (now >= nextUiUpdate) {
          nextUiUpdate = now + 240;
          setRevision((value) => value + 1);
        }
        if (now >= nextSave) {
          nextSave = now + 4_000;
          saveWorld(activeWorld);
        }
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      if (worldRef.current) saveWorld(worldRef.current);
    };
  }, [paused, reducedMotion]);

  const stopAgents = useCallback(() => {
    const worker = workerRef.current;
    workerRef.current = undefined;
    if (worker) {
      worker.postMessage({ protocol: WORLD_PROTOCOL, type: "shutdown" });
      window.setTimeout(() => worker.terminate(), 900);
    }
    pendingBatches.current.clear();
    pendingRequests.current.clear();
    setRuntimeStatus("offline");
    runtimeStatusRef.current = "offline";
    setAgentError(undefined);
    if (worldRef.current) setWorldAgentsOnline(worldRef.current, false);
    setRevision((value) => value + 1);
  }, []);

  const receiveAgentMessage = useCallback((worker: Worker, message: WorldAgentMessage) => {
    if (workerRef.current !== worker) return;
    if (message.type === "status") {
      if (message.status === "ready") {
        setRuntimeStatus("ready");
        runtimeStatusRef.current = "ready";
        setAgentError(undefined);
        setAgentNotice(undefined);
        const now = performance.now();
        liveAgentIdsInWorld(worldRef.current as WorldState).forEach((id, index) => {
          nextThinkAt.current[id] = worldRef.current && hasUnansweredGuildCall(worldRef.current, id)
            ? now
            : now + index * 80;
        });
        if (worldRef.current) setWorldAgentsOnline(worldRef.current, true);
      } else if (message.status === "error") {
        const failureMessage = message.message ?? "The world agents could not connect.";
        const status = isWorldUsageLimitMessage(failureMessage) ? "blocked" : "error";
        setRuntimeStatus(status);
        runtimeStatusRef.current = status;
        setAgentError(failureMessage);
        if (worldRef.current) setWorldAgentsOnline(worldRef.current, false);
      } else if (message.status === "stopped") {
        pendingBatches.current.clear();
        pendingRequests.current.clear();
        setRuntimeStatus("offline");
        runtimeStatusRef.current = "offline";
        if (worldRef.current) setWorldAgentsOnline(worldRef.current, false);
      }
      setRevision((value) => value + 1);
      return;
    }
    if (message.type === "batch_result") {
      const batch = pendingBatches.current.get(message.batchId);
      if (!batch || batch.resultReceived) return;
      batch.resultReceived = true;
      if (!batch.usageCounted) {
        commitModelBatchUsage(message.usage, usageRef, setUsage);
        batch.usageCounted = true;
      }
      const activeWorld = worldRef.current;
      if (!activeWorld) return;
      let accepted = 0;
      const rejected: string[] = [];
      for (const decision of message.decisions) {
        const application = applyWorldPlan(activeWorld, decision.plan);
        if (application.accepted) {
          applyResidentMemory(activeWorld, decision.plan.agentId, decision.memory);
          accepted += 1;
          continue;
        }
        batch.rejectedResidentIds.add(decision.plan.agentId);
        rejected.push(`${activeWorld.actors[decision.plan.agentId].name} (${application.reason})`);
      }
      setAgentNotice(rejected.length === 0
        ? `Luna batch applied ${accepted} resident plan${accepted === 1 ? "" : "s"}.`
        : `Luna batch applied ${accepted}/${message.decisions.length} resident plans; discarded ${rejected.join(", ")}.`);
      setRevision((value) => value + 1);
      return;
    }
    if (message.type !== "batch_settled") return;
    const batch = pendingBatches.current.get(message.batchId);
    if (!batch) return;
    if (!batch.usageCounted && (message.usage || message.outcome !== "cancelled")) {
      commitModelBatchUsage(message.usage, usageRef, setUsage);
      batch.usageCounted = true;
    }
    pendingBatches.current.delete(batch.batchId);
    for (const request of batch.requests) {
      if (pendingRequests.current.get(request.requestId)?.batchId === batch.batchId) {
        pendingRequests.current.delete(request.requestId);
      }
    }

    const failureMessage = message.message ?? failureDescription(message.failure);
    const terminallyBlocked = message.failure === "usage_limit"
      || message.failure === "budget"
      || isWorldUsageLimitMessage(failureMessage);
    const now = performance.now();
    const activeWorld = worldRef.current;
    for (const request of batch.requests) {
      const unanswered = activeWorld
        ? hasUnansweredPlayerOrder(activeWorld, request.agentId)
          || hasUnansweredGuildCall(activeWorld, request.agentId)
        : false;
      const retryDelay = terminallyBlocked || runtimeStatusRef.current === "blocked"
        ? Number.POSITIVE_INFINITY
        : unanswered
          ? message.outcome === "failed" ? 6_000 : 0
          : batch.rejectedResidentIds.has(request.agentId)
            ? 2_000
            : message.outcome === "completed"
              ? 7_500
              : message.outcome === "cancelled"
                ? 2_500
                : 8_000;
      nextThinkAt.current[request.agentId] = retryDelay === Number.POSITIVE_INFINITY
        ? retryDelay
        : now + retryDelay + residentDelay(request.agentId);
    }

    if (terminallyBlocked) {
      const notice = message.failure === "usage_limit"
        ? `Luna usage limit reached; automatic retries are stopped. ${failureMessage}`
        : `Luna model batches are blocked; automatic retries are stopped. ${failureMessage}`;
      setRuntimeStatus("blocked");
      runtimeStatusRef.current = "blocked";
      setAgentError(notice);
      setAgentNotice(notice);
      if (activeWorld) setWorldAgentsOnline(activeWorld, false);
    } else if (message.outcome === "failed") {
      const names = batch.requests.map(({ agentId }) => activeWorld?.actors[agentId].name ?? agentId);
      setAgentNotice(`Luna batch for ${names.join(", ")} failed: ${failureMessage}`);
    } else if (message.outcome === "completed" && !batch.resultReceived) {
      setAgentNotice("A Luna batch completed without a usable result; its residents were rescheduled.");
    }

    if (modelBudgetExhausted(usageRef.current)) {
      const notice = `The ${MAX_MODEL_BATCHES}-batch or ${MAX_AGENT_TOKENS.toLocaleString()}-token Luna budget is complete. Reset the town to replenish it.`;
      setRuntimeStatus("blocked");
      runtimeStatusRef.current = "blocked";
      setAgentError(notice);
      setAgentNotice(notice);
      if (activeWorld) setWorldAgentsOnline(activeWorld, false);
    }
    setRevision((value) => value + 1);
  }, []);

  const startAgents = useCallback(() => {
    if (
      capabilityError
      || (credentialSource !== "subscription" && credentialSource !== "user")
      || runtimeStatusRef.current === "starting"
      || runtimeStatusRef.current === "ready"
    ) return;
    if (modelBudgetExhausted(usageRef.current)) {
      const notice = "The local Luna model-batch budget is complete. Reset the town before waking the minds again.";
      setRuntimeStatus("blocked");
      runtimeStatusRef.current = "blocked";
      setAgentError(notice);
      return;
    }
    workerRef.current?.terminate();
    const worker = new Worker(new URL("./monsterWorldAgent.worker.ts", import.meta.url), {
      type: "module",
      name: "nanocodex-monster-world",
    });
    workerRef.current = worker;
    pendingBatches.current.clear();
    pendingRequests.current.clear();
    setAgentError(undefined);
    setAgentNotice(undefined);
    setRuntimeStatus("starting");
    runtimeStatusRef.current = "starting";
    worker.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
      if (!isWorldAgentMessage(data)) return;
      receiveAgentMessage(worker, data);
    });
    worker.addEventListener("error", (event) => {
      if (workerRef.current !== worker) return;
      workerRef.current = undefined;
      setRuntimeStatus("error");
      runtimeStatusRef.current = "error";
      setAgentError(event.message || "The browser Worker could not start the world agents.");
      pendingBatches.current.clear();
      pendingRequests.current.clear();
      if (worldRef.current) setWorldAgentsOnline(worldRef.current, false);
      setRevision((value) => value + 1);
    });
    worker.postMessage({ protocol: WORLD_PROTOCOL, type: "connect" });
  }, [capabilityError, credentialSource, receiveAgentMessage]);

  useEffect(() => {
    if (runtimeStatus !== "ready") return;
    const schedule = () => {
      const activeWorld = worldRef.current;
      const worker = workerRef.current;
      if (
        !activeWorld
        || !worker
        || document.visibilityState !== "visible"
        || paused
      ) return;
      if (modelBudgetExhausted(usageRef.current)) {
        const notice = "The local Luna model-batch budget is complete. Reset the town to replenish it.";
        setRuntimeStatus("blocked");
        runtimeStatusRef.current = "blocked";
        setAgentError(notice);
        setAgentNotice(notice);
        setWorldAgentsOnline(activeWorld, false);
        return;
      }
      const reservedBatches = [...pendingBatches.current.values()]
        .filter(({ usageCounted }) => !usageCounted).length;
      let availableBatchSlots = MAX_MODEL_BATCHES
        - usageRef.current.modelBatches
        - reservedBatches;
      if (availableBatchSlots <= 0) return;
      const now = performance.now();
      const occupiedLanes = new Set([...pendingBatches.current.values()].map(({ lane }) => lane));
      const activeAgentIds = new Set([...pendingRequests.current.values()].map(({ agentId }) => agentId));
      const dueByLane = Array.from({ length: LUNA_LANE_COUNT }, () => [] as ResidentId[]);
      const orderedAgentIds = [...liveAgentIdsInWorld(activeWorld)].sort((left, right) => {
        const callPriority = Number(
          hasUnansweredPlayerOrder(activeWorld, right) || hasUnansweredGuildCall(activeWorld, right),
        ) - Number(
          hasUnansweredPlayerOrder(activeWorld, left) || hasUnansweredGuildCall(activeWorld, left),
        );
        return callPriority || AUTONOMOUS_AGENT_IDS.indexOf(left) - AUTONOMOUS_AGENT_IDS.indexOf(right);
      });
      for (const agentId of orderedAgentIds) {
        const lane = laneForResident(agentId);
        if (occupiedLanes.has(lane) || activeAgentIds.has(agentId)) continue;
        if (now < nextThinkAt.current[agentId]) continue;
        const actor = activeWorld.actors[agentId];
        if (
          actor.activeOrderId !== undefined
          || actor.tasks.length > 0
          || actor.movement
          || actor.departure
        ) continue;
        const laneEntries = dueByLane[lane];
        if (laneEntries && laneEntries.length < MAX_RESIDENTS_PER_BATCH) laneEntries.push(agentId);
      }

      let dispatched = false;
      for (let lane = 0; lane < LUNA_LANE_COUNT && availableBatchSlots > 0; lane += 1) {
        const agentIds = dueByLane[lane];
        if (!agentIds || agentIds.length === 0 || occupiedLanes.has(lane)) continue;
        const batchId = `world-batch-${crypto.randomUUID()}`;
        const requests = agentIds.map((agentId): PendingResidentRequest => Object.freeze({
          requestId: `world-request-${crypto.randomUUID()}`,
          batchId,
          agentId,
          lane,
        }));
        const entries: WorldBatchThinkEntry[] = requests.map(({ requestId, agentId }) => ({
          requestId,
          agentId,
          observation: observationFor(activeWorld, agentId),
          memory: residentMemoryFor(activeWorld, agentId),
        }));
        const batch: PendingBatch = {
          batchId,
          lane,
          requests: Object.freeze(requests),
          usageCounted: false,
          resultReceived: false,
          rejectedResidentIds: new Set(),
        };
        pendingBatches.current.set(batchId, batch);
        for (const request of requests) {
          pendingRequests.current.set(request.requestId, request);
          nextThinkAt.current[request.agentId] = Number.POSITIVE_INFINITY;
        }
        try {
          worker.postMessage({
            protocol: WORLD_PROTOCOL,
            type: "think_batch",
            batchId,
            entries,
          } satisfies WorldAgentCommand);
          dispatched = true;
          availableBatchSlots -= 1;
        } catch (cause) {
          pendingBatches.current.delete(batchId);
          for (const request of requests) {
            pendingRequests.current.delete(request.requestId);
            nextThinkAt.current[request.agentId] = now + 5_000 + residentDelay(request.agentId);
          }
          setAgentNotice(`Could not send a Luna batch: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      if (dispatched) setRevision((value) => value + 1);
    };
    schedule();
    const timer = window.setInterval(schedule, 500);
    return () => window.clearInterval(timer);
  }, [paused, runtimeStatus]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        heldDirections.current.clear();
        stopAgents();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [stopAgents]);

  useEffect(() => {
    if (credentialSource === null && workerRef.current) stopAgents();
  }, [credentialSource, stopAgents]);

  useEffect(() => () => {
    const worker = workerRef.current;
    workerRef.current = undefined;
    if (worker) {
      worker.postMessage({ protocol: WORLD_PROTOCOL, type: "shutdown" });
      window.setTimeout(() => worker.terminate(), 700);
    }
    pendingBatches.current.clear();
    pendingRequests.current.clear();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (document.activeElement !== canvasRef.current) return;
      const direction = directionForKey(event.key);
      if (direction) {
        event.preventDefault();
        heldDirections.current.delete(direction);
        heldDirections.current.add(direction);
        return;
      }
      if (event.repeat) return;
      if (event.code === "Space") {
        event.preventDefault();
        playerInteract(worldRef.current as WorldState);
        setRevision((value) => value + 1);
        return;
      }
      const voice = voiceLevelForKey(event.key);
      if (voice) {
        event.preventDefault();
        setVoiceLevel(voice);
        return;
      }
      if (event.key.toLowerCase() === "q") {
        event.preventDefault();
        setVoiceLevel((current) => nextVoiceLevel(current));
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const direction = directionForKey(event.key);
      if (direction) heldDirections.current.delete(direction);
    };
    const onWindowBlur = () => heldDirections.current.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  const cancelResidentBatches = (ids: readonly ResidentId[]): number => {
    const residents = new Set(ids);
    const batchIds = [...pendingBatches.current.values()]
      .filter(({ requests }) => requests.some(({ agentId }) => residents.has(agentId)))
      .map(({ batchId }) => batchId);
    if (batchIds.length > 0) {
      workerRef.current?.postMessage({
        protocol: WORLD_PROTOCOL,
        type: "cancel",
        batchIds,
      } satisfies WorldAgentCommand);
    }
    return batchIds.length;
  };

  const submitDialogue = (event: FormEvent) => {
    event.preventDefault();
    if (!worldRef.current) return;
    const speech = playerSpeak(worldRef.current, draft, voiceLevel);
    if (!speech) return;
    const mindsToWake = speech.liveAddressed;
    for (const agentId of mindsToWake) nextThinkAt.current[agentId] = 0;
    cancelResidentBatches(mindsToWake);
    setPaused(false);
    if (speech.order) {
      setSpeechNotice(undefined);
      setLatestOrderId(speech.order.id);
    } else {
      setLatestOrderId(undefined);
      setSpeechNotice(
        `Raw order delivered to ${mindsToWake.length} resident mind${mindsToWake.length === 1 ? "" : "s"}. Each Luna resident will interpret it from their own identity and world state; no destination was assumed by the page.`,
      );
    }
    if (mindsToWake.length > 0) startAgents();
    setDraft("");
    setRevision((value) => value + 1);
  };

  const nudgePlayer = (direction: Direction) => {
    if (worldRef.current) movePlayer(worldRef.current, direction);
    canvasRef.current?.focus();
  };

  const cancelDepartingTurns = (ids: readonly ResidentId[]) => {
    cancelResidentBatches(ids);
  };

  const departResident = (residentId: ResidentId): boolean => {
    const activeWorld = worldRef.current;
    if (!activeWorld || !requestResidentExit(activeWorld, residentId)) return false;
    cancelDepartingTurns([residentId]);
    setLatestOrderId(undefined);
    setSpeechNotice(`${activeWorld.actors[residentId].name} decided to walk out through the nearest map edge.`);
    setRevision((value) => value + 1);
    return true;
  };

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.focus();
    const activeWorld = worldRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!activeWorld || rect.width <= 0 || rect.height <= 0) return;
    const viewportX = ((event.clientX - rect.left) / rect.width) * WORLD_PIXEL_WIDTH;
    const viewportY = ((event.clientY - rect.top) / rect.height) * WORLD_PIXEL_HEIGHT;
    const point = viewportToWorld(worldCameraForState(activeWorld), viewportX, viewportY);
    const residentId = residentAtWorldPoint(activeWorld, point.scene, point.x, point.y);
    if (residentId) departResident(residentId);
  };

  const changePopulation = (requested: number) => {
    const activeWorld = worldRef.current;
    if (!activeWorld) return;
    const change = setPopulationTarget(activeWorld, requested);
    cancelDepartingTurns(change.exiting);
    setLatestOrderId(undefined);
    setSpeechNotice(
      change.entering.length > 0
        ? `${change.entering.length} resident${change.entering.length === 1 ? " is" : "s are"} joining from map edges or turning back into town.`
        : change.exiting.length > 0
          ? `${change.exiting.length} resident${change.exiting.length === 1 ? " is" : "s are"} walking out under their own power.`
          : undefined,
    );
    setRevision((value) => value + 1);
  };

  const resetTown = () => {
    stopAgents();
    localStorage.removeItem(WORLD_SAVE_KEY);
    worldRef.current = createWorldState();
    nextThinkAt.current = createThinkSchedule();
    usageRef.current = emptyUsage;
    setUsage(emptyUsage);
    setAgentError(undefined);
    setAgentNotice(undefined);
    setSpeechNotice(undefined);
    setLatestOrderId(undefined);
    setSelectedResident("cinder");
    setPaused(false);
    setRevision((value) => value + 1);
  };

  const hasCredential = credentialSource === "subscription" || credentialSource === "user";
  const agentStatus: AgentStatus = capabilityError || !hasCredential
    ? "idle"
    : runtimeStatus === "ready"
      ? "ready"
      : runtimeStatus === "error" || runtimeStatus === "blocked"
        ? "error"
        : "stopped";
  const pendingByAgent = new Set([...pendingRequests.current.values()].map(({ agentId }) => agentId));
  const relayActive = isGuildRelayActive(world);
  const residentsOnMap = activeResidentCount(world);
  const onMapMindIds = AUTONOMOUS_AGENT_IDS.filter((id) => world.actors[id].presence !== "absent");
  const scout = world.actors.player;
  const scoutPosition = actorWorldPosition(scout);
  const currentSceneLabel = sceneLabel(scoutPosition.scene);
  const residentsInScene = onMapMindIds.filter((id) => (
    actorWorldPosition(world.actors[id]).scene === scoutPosition.scene
  )).length;
  const carriedItem = carriedItemLabel(scout.carrying);
  const localBudgetComplete = modelBudgetExhausted(usage);
  const selectableResidents = RESIDENT_IDS.filter((id) => {
    const presence = world.actors[id].presence;
    return presence === "active" || presence === "entering";
  });
  const selectedResidentId = selectableResidents.includes(selectedResident)
    ? selectedResident
    : selectableResidents[0];
  const lunaStatus = runtimeStatus === "ready"
    ? "Luna online"
    : runtimeStatus === "blocked"
      ? "Luna blocked"
      : runtimeStatus === "error"
        ? "Luna error"
        : "Luna offline";
  const worldStatus = `${currentSceneLabel} · ${lunaStatus}`;
  const latestOrderNotice = latestOrderId === undefined
    ? undefined
    : orderProgressNotice(world, latestOrderId);
  const currentSpeechNotice = [speechNotice, latestOrderNotice].filter(Boolean).join(" ");
  void revision;

  return (
    <section className="monster-world" aria-labelledby="monster-world-title">
      <header className="monster-world-heading">
        <div>
          <p>Nanocodex field study 001 · 64×48 connected district · browser local</p>
          <h1 id="monster-world-title">Springleaf Rescue District</h1>
        </div>
        <span className={runtimeStatus === "ready" ? "is-live" : ""}>
          <i aria-hidden="true" /> {worldStatus}
        </span>
      </header>

      <div className="monster-world-layout">
        <div className="monster-world-play-column">
          <section className="monster-world-stage-shell" aria-label={`Playable Springleaf district, current scene ${currentSceneLabel}`}>
            <div className="monster-world-stage-head">
              <span>{residentsInScene} here · {residentsOnMap} district-wide · target {world.populationTarget}/{MAX_RESIDENT_COUNT}</span>
              <span className="monster-world-scene-plaque">{currentSceneLabel}</span>
              <span>{formatWorldTime(world.minuteOfDay)} · {world.weather}</span>
            </div>
            <div className="monster-world-stage">
              <canvas
                ref={canvasRef}
                width={WORLD_PIXEL_WIDTH}
                height={WORLD_PIXEL_HEIGHT}
                tabIndex={0}
                onBlur={() => heldDirections.current.clear()}
                onPointerDown={handleCanvasPointerDown}
                role="img"
                aria-describedby="monster-world-description"
                aria-label={`${currentSceneLabel}, the current scene in a connected 64 by 48 tile district. ${residentsInScene} residents share this scene and can be selected on the map; ${residentsOnMap} are active district-wide. Scout has ${Math.round(scout.energy)} energy and is carrying ${carriedItem.toLowerCase()}. Enter the guild and shop through their doors, gather a sunberry in the orchard, deliver it to the shop, carry a supply pack to the guild, rest, or train. The guild journal lists residents in every scene.`}
              />
              <div className="monster-world-map-stamp" aria-hidden="true">64×48 DISTRICT · {currentSceneLabel}</div>
            </div>
            <p className="sr-only" id="monster-world-description">
              Explore a connected 64 by 48 tile district. Walk through the marked guild and shop doors to enter their interior scenes. Focus the map, then move Scout with arrow keys or WASD. Press Space or activate the on-screen A control near a resident or landmark to interact. Gather a sunberry in the orchard, deliver it to the shop, take a supply pack to the guild, rest to recover energy, and train at the meadow. Click a resident in Scout’s current scene to ask them to walk out; residents in other scenes remain available in the cast. Press Q to cycle voice loudness or 1 through 4 to select it directly. Calls reach only residents inside the audible radius, except at the guild relay where everyone hears you. The population slider adds or removes residents with visible entrances and departures.
            </p>
            <dl className="monster-world-hud" aria-label="Scout and district supplies">
              <div className="monster-world-hud-scene"><dt>Current scene</dt><dd>{currentSceneLabel}</dd></div>
              <div><dt>Scout energy</dt><dd>{Math.round(scout.energy)}%</dd></div>
              <div><dt>Satchel</dt><dd>{carriedItem}</dd></div>
              <div><dt>Orchard berries</dt><dd>{world.supplies.orchardBerries}</dd></div>
              <div><dt>Shop stock</dt><dd>{world.supplies.shopStock}</dd></div>
              <div><dt>Guild supplies</dt><dd>{world.supplies.guildSupplies}</dd></div>
              <div><dt>Training marks</dt><dd>{world.supplies.trainingMarks}</dd></div>
            </dl>
            <p className="monster-world-route-guide">
              Enter the guild and shop doors · orchard sunberry → shop → supply pack → guild · rest to recover · train at the meadow · <kbd>A</kbd>/<kbd>Space</kbd> interacts
            </p>
            <div className="monster-world-command-row">
              <div className="monster-world-dpad" role="group" aria-label="Movement controls">
                <button type="button" aria-label="Move up" onClick={() => nudgePlayer("up")}>↑</button>
                <button type="button" aria-label="Move left" onClick={() => nudgePlayer("left")}>←</button>
                <button type="button" aria-label="Interact" onClick={() => {
                  playerInteract(world);
                  setRevision((value) => value + 1);
                }}>A</button>
                <button type="button" aria-label="Move right" onClick={() => nudgePlayer("right")}>→</button>
                <button type="button" aria-label="Move down" onClick={() => nudgePlayer("down")}>↓</button>
              </div>
              <form className="monster-world-talk" onSubmit={submitDialogue}>
                <label htmlFor="world-dialogue">Orchestrate by voice</label>
                <div>
                  <input
                    id="world-dialogue"
                    aria-describedby="monster-world-hearing"
                    value={draft}
                    maxLength={140}
                    placeholder="Cinder, check the bridge…"
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button type="submit" disabled={!draft.trim()}>call</button>
                </div>
                <div className="monster-world-voice" role="group" aria-label="Voice loudness">
                  {VOICE_LEVELS.map((level, index) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={voiceLevel === level}
                      onClick={() => setVoiceLevel(level)}
                    ><kbd>{index + 1}</kbd>{level}</button>
                  ))}
                </div>
                <p id="monster-world-hearing" className="monster-world-hearing" aria-live="polite">
                  {relayActive
                    ? `Guild relay active: every on-map resident hears you across all scenes.`
                    : `${voiceLevel} reaches ${VOICE_RADIUS[voiceLevel]} tiles · Q cycles loudness.`}
                </p>
                {currentSpeechNotice ? <p className="monster-world-speech-notice" role="status">{currentSpeechNotice}</p> : null}
              </form>
            </div>
            <div className="monster-world-population">
              <label htmlFor="world-population">
                Town population
                <output htmlFor="world-population">{residentsOnMap} on map · target {world.populationTarget}</output>
              </label>
              <input
                id="world-population"
                type="range"
                min="0"
                max={MAX_RESIDENT_COUNT}
                step="1"
                value={world.populationTarget}
                onChange={(event) => changePopulation(Number(event.currentTarget.value))}
              />
              <p>Raise the slider to bring characters in from random points just outside the 64×48 district. Click a visible resident in Scout’s current scene to make them walk out; use the cast to choose anyone elsewhere.</p>
              <div className="monster-world-resident-exit">
                <label htmlFor="world-resident-exit">Choose a resident</label>
                <div>
                  <select
                    id="world-resident-exit"
                    value={selectedResidentId ?? ""}
                    disabled={!selectedResidentId}
                    onChange={(event) => {
                      if (isResidentId(event.currentTarget.value)) {
                        setSelectedResident(event.currentTarget.value);
                      }
                    }}
                  >
                    {selectableResidents.map((id) => (
                      <option key={id} value={id}>{world.actors[id].name} · {world.actors[id].role}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!selectedResidentId}
                    onClick={() => {
                      if (selectedResidentId) departResident(selectedResidentId);
                    }}
                  >ask to leave</button>
                </div>
              </div>
            </div>
          </section>

          <section className="monster-world-mission" aria-labelledby="world-mission-title">
            <div>
              <p>Active expedition · clue {Math.min(world.mission.stage + 1, 3)}/3</p>
              <h2 id="world-mission-title">{world.mission.title}</h2>
            </div>
            <p>{world.mission.detail}</p>
          </section>
        </div>

        <aside className="monster-world-journal" aria-label="Guild controls and activity">
          <div className="monster-world-agent-panel">
            <AgentSessionBar
              agentStatus={agentStatus}
              agentError={agentError}
              source={credentialSource}
              capabilityError={capabilityError}
              onAuthStatusChange={setAuthStatus}
              onRetryAgent={startAgents}
              onSourceChange={setCredentialSource}
            />
            <div className="monster-world-agent-actions">
              {runtimeStatus === "ready" ? (
                <button type="button" onClick={stopAgents}>stop agents</button>
              ) : (
                <button
                  type="button"
                  disabled={
                    !hasCredential
                    || Boolean(capabilityError)
                    || runtimeStatus === "starting"
                    || onMapMindIds.length === 0
                    || localBudgetComplete
                  }
                  onClick={startAgents}
                >{localBudgetComplete
                    ? "model budget complete"
                    : `${runtimeStatus === "blocked" || runtimeStatus === "error" ? "retry" : "wake"} ${onMapMindIds.length} minds`}</button>
              )}
              <button type="button" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>
                {paused ? "resume town" : "pause town"}
              </button>
              <button type="button" onClick={resetTown}>reset</button>
            </div>
            {agentNotice ? <p className="monster-world-agent-notice" role="status">{agentNotice}</p> : null}
          </div>

          <section className="monster-world-cast" aria-labelledby="world-cast-title">
            <header>
              <div><p>All on-map residents · retained private memory</p><h2 id="world-cast-title">Autonomous minds</h2></div>
              <span>{pendingBatches.current.size} model batch{pendingBatches.current.size === 1 ? "" : "es"} active</span>
            </header>
            <div className="monster-world-scale" aria-label="World population architecture">
              <span><strong>{residentsOnMap}</strong> on map</span>
              <span><strong>{LUNA_LANE_COUNT}</strong> retained Luna lanes</span>
              <span><strong>{MAX_RESIDENTS_PER_BATCH}</strong> minds per batch</span>
            </div>
            <ol>
              {onMapMindIds.map((id) => {
                const actor = world.actors[id];
                const live = runtimeStatus === "ready" && actor.presence === "active";
                const listening = hasUnansweredGuildCall(world, id);
                return (
                  <li key={id}>
                    <AgentPortrait actor={actor} />
                    <span>
                      <strong>{actor.name}<small>{actor.role} · {sceneLabel(actorWorldPosition(actor).scene)}</small></strong>
                      <em>
                        <i>{actor.intent ?? actor.activity}</i>
                        {actor.intent && actor.activity !== actor.intent
                          ? <small>now · {actor.activity}</small>
                          : null}
                      </em>
                    </span>
                    <b className={live ? "is-agent" : ""}>
                      {actor.presence === "absent"
                        ? "away"
                        : actor.presence === "entering"
                          ? "entering"
                          : actor.presence === "exiting"
                            ? "leaving"
                            : actor.activeOrderId !== undefined
                              ? "obeying"
                              : pendingByAgent.has(id)
                                ? "thinking"
                                : listening
                                  ? "heard call"
                                  : actor.lastOrigin === "nanocodex"
                                    ? "nanocodex"
                                    : live
                                      ? `lane ${laneForResident(id) + 1} · live`
                                      : runtimeStatus === "blocked"
                                        ? "Luna blocked"
                                        : runtimeStatus === "error"
                                          ? "Luna error"
                                          : "Luna offline"}
                    </b>
                  </li>
                );
              })}
            </ol>
          </section>

          {world.orders.length > 0 ? (
            <section className="monster-world-orders" aria-labelledby="world-orders-title">
              <header>
                <div><p>Reducer-owned execution receipts</p><h2 id="world-orders-title">Scout orders</h2></div>
                <span aria-live="polite">{world.orders.length} retained</span>
              </header>
              <ol>
                {world.orders.slice(0, 3).map((order) => {
                  const completed = order.assignments.filter(({ status }) => status === "completed").length;
                  const active = order.assignments.filter(({ status }) => status === "assigned" || status === "moving").length;
                  const executable = order.assignments.filter(({ status }) => status !== "rejected").length;
                  return (
                    <li key={order.id} data-active={active > 0 ? "true" : "false"}>
                      <div>
                        <strong>Order {order.id}</strong>
                        <span>{completed}/{executable} complete · {active} moving</span>
                      </div>
                      <p>“{order.text}”</p>
                      <progress
                        max={Math.max(executable, 1)}
                        value={completed}
                        aria-label={`Order ${order.id}: ${completed} of ${executable} residents completed`}
                      />
                      <ul>
                        {order.assignments.map((assignment) => (
                          <li key={assignment.actorId} data-status={assignment.status}>
                            <span>{world.actors[assignment.actorId].name}</span>
                            <small>
                              {assignment.interaction
                                ? `${assignment.interaction} · ${assignment.target.replaceAll("_", " ")}`
                                : assignment.target.replaceAll("_", " ")}
                            </small>
                            <b>{assignment.status}</b>
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          <section className="monster-world-board" aria-labelledby="world-board-title">
            <header>
              <div><p>Every agent reads this before acting</p><h2 id="world-board-title">Message board</h2></div>
              <span aria-live="polite">{world.guildMessages.length} posts</span>
            </header>
            <ol>
              {world.guildMessages.slice(0, 7).map((message) => {
                const from = world.actors[message.fromId];
                const to = message.toId === undefined ? undefined : world.actors[message.toId];
                const audience = message.audience?.map((id) => world.actors[id].name).join(", ");
                const destination = to
                  ? to.name
                  : message.scope === "spatial"
                    ? `heard by ${audience || "nearby listeners"}`
                    : "public room";
                return (
                  <li key={message.id} data-origin={message.origin}>
                    <div>
                      <strong>{from.name} → {destination}</strong>
                      <span>{message.origin} · <time>{formatWorldTime(message.minuteOfDay)}</time></span>
                    </div>
                    <p>“{message.text}”</p>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="monster-world-activity" aria-labelledby="world-activity-title">
            <header>
              <div><p>Semantic event stream</p><h2 id="world-activity-title">Guild journal</h2></div>
              <span aria-live="polite">{world.activities.length} events</span>
            </header>
            <ol>
              {world.activities.slice(0, 9).map((entry) => (
                <li key={entry.id} data-origin={entry.origin}>
                  <time>{formatWorldTime(entry.minuteOfDay)}</time>
                  <p>{entry.text}</p>
                  <span>{entry.origin}</span>
                </li>
              ))}
            </ol>
          </section>

          <footer className="monster-world-budget">
            <div>
              <span>model-batch budget</span>
              <strong>{usage.modelBatches}/{MAX_MODEL_BATCHES} batches</strong>
            </div>
            <progress max={MAX_AGENT_TOKENS} value={usage.totalTokens} aria-label="World Luna token soft cutoff" />
            <p>{usage.totalTokens.toLocaleString()} tokens toward the soft cutoff · {usage.estimatedUsd > 0 ? `$${usage.estimatedUsd.toFixed(4)} estimated` : "cost appears when reported"}</p>
            <p>GPT-5.6 Luna · thinking none · {LUNA_LANE_COUNT} retained lanes · up to {MAX_RESIDENTS_PER_BATCH} residents per model batch.</p>
            <p>Scout orders are reducer-owned and remain physical under model failure. Autonomous entries marked <b>nanocodex</b> come only from completed Luna batches.</p>
          </footer>
        </aside>
      </div>
    </section>
  );
}

function AgentPortrait({ actor }: Readonly<{ actor: WorldActor }>) {
  if (actor.kind === "monster") {
    return (
      <img
        className="monster-world-portrait"
        src={`/world/my-pixel-world/menu-sprites/menusprite${actor.sprite}.png`}
        alt=""
        width="32"
        height="32"
      />
    );
  }
  return (
    <span
      className="monster-world-portrait is-human"
      aria-hidden="true"
      style={{
        backgroundImage: `url(/world/my-pixel-world/character-overworld/ow${actor.sprite}.png)`,
      }}
    />
  );
}

function carriedItemLabel(item: WorldActor["carrying"]): string {
  if (item === "sunberry") return "Sunberry";
  if (item === "supply_pack") return "Supply pack";
  return "Empty satchel";
}

function commitModelBatchUsage(
  batch: WorldUsage | undefined,
  usageRef: { current: UsageTotals },
  publish: (usage: UsageTotals) => void,
): UsageTotals {
  const next = {
    modelBatches: usageRef.current.modelBatches + 1,
    inputTokens: usageRef.current.inputTokens + (batch?.inputTokens ?? 0),
    outputTokens: usageRef.current.outputTokens + (batch?.outputTokens ?? 0),
    totalTokens: usageRef.current.totalTokens + (batch?.totalTokens ?? 0),
    estimatedUsd: usageRef.current.estimatedUsd + (Number(batch?.estimatedUsd) || 0),
  };
  usageRef.current = next;
  publish(next);
  return next;
}

function modelBudgetExhausted(usage: UsageTotals): boolean {
  return usage.modelBatches >= MAX_MODEL_BATCHES || usage.totalTokens >= MAX_AGENT_TOKENS;
}

function failureDescription(failure: WorldFailureClass | undefined): string {
  if (failure === "usage_limit") return "The Luna usage limit was reached.";
  if (failure === "budget") return "The Luna model-batch safety budget was reached.";
  if (failure === "transient") return "A temporary Luna transport failure interrupted the batch.";
  if (failure === "invalid") return "The Luna batch result did not satisfy the world contract.";
  if (failure === "cancelled") return "The Luna batch was cancelled.";
  return "Unknown Luna model-batch failure.";
}

function orderProgressNotice(state: WorldState, orderId: number): string | undefined {
  const order = state.orders.find(({ id }) => id === orderId);
  if (!order) return undefined;
  const completed = order.assignments.filter(({ status }) => status === "completed").length;
  const active = order.assignments.filter(({ status }) => status === "assigned" || status === "moving").length;
  const rejected = order.assignments.filter(({ status }) => status === "rejected").length;
  const preempted = order.assignments.filter(({ status }) => status === "preempted").length;
  const stateLabel = !order.completionEmitted
    ? "in progress"
    : rejected === 0 && preempted === 0
      ? "complete"
      : "settled";
  return `Order ${order.id} ${stateLabel}: ${completed} completed · ${active} active · ${rejected} rejected · ${preempted} preempted.`;
}

function readSavedWorld(): string | null {
  try {
    return localStorage.getItem(WORLD_SAVE_KEY);
  } catch {
    return null;
  }
}

function saveWorld(world: WorldState): void {
  try {
    localStorage.setItem(WORLD_SAVE_KEY, serializeWorldState(world));
  } catch {
    // Local persistence is optional; the complete in-tab simulation keeps running.
  }
}

function worldCapabilityError(): string | undefined {
  if (typeof Worker !== "function") return "This browser does not support module Workers.";
  if (typeof WebAssembly !== "object") return "This browser does not support WebAssembly.";
  if (typeof WebSocket !== "function") return "This browser does not support WebSockets.";
  if (typeof crypto?.randomUUID !== "function") return "This browser cannot create secure world turn identifiers.";
  return undefined;
}

function directionForKey(key: string): Direction | undefined {
  const normalized = key.toLowerCase();
  if (normalized === "arrowup" || normalized === "w") return "up";
  if (normalized === "arrowdown" || normalized === "s") return "down";
  if (normalized === "arrowleft" || normalized === "a") return "left";
  if (normalized === "arrowright" || normalized === "d") return "right";
  return undefined;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.matches("input, textarea, button, [contenteditable='true']");
}

function createThinkSchedule(): Record<ResidentId, number> {
  return Object.fromEntries(
    AUTONOMOUS_AGENT_IDS.map((id) => [id, 0]),
  ) as Record<ResidentId, number>;
}

function laneForResident(id: ResidentId): number {
  const index = AUTONOMOUS_AGENT_IDS.indexOf(id);
  return index < 0 ? 0 : index % LUNA_LANE_COUNT;
}

function residentDelay(id: ResidentId): number {
  const index = AUTONOMOUS_AGENT_IDS.indexOf(id);
  return Math.max(index, 0) % 12 * 120;
}

function voiceLevelForKey(key: string): VoiceLevel | undefined {
  const index = Number(key) - 1;
  return Number.isInteger(index) && index >= 0 && index < VOICE_LEVELS.length
    ? VOICE_LEVELS[index]
    : undefined;
}

function nextVoiceLevel(current: VoiceLevel): VoiceLevel {
  const index = VOICE_LEVELS.indexOf(current);
  return VOICE_LEVELS[(index + 1) % VOICE_LEVELS.length] ?? "call";
}
