import type { Dialog } from "nanocodex/connect";
import { Wata, postMessage } from "wata/host";

type WalletRequestBase = Readonly<{
  id: string;
  origin: string;
  rpc: Readonly<{ method: string; params?: unknown }>;
}>;

export type WalletRequest =
  | WalletRequestBase & Readonly<{ type: "walletConnect" }>
  | WalletRequestBase & Readonly<{ type: "walletRevokeAccessKey" }>;

export type Request = WalletRequest | Dialog.FundingRequest;

type WalletEvent = Readonly<{
  request: WalletRequest["rpc"];
  respond(result: unknown): Promise<unknown>;
  reject(error: Readonly<{ code: number; message: string }>): Promise<unknown>;
}>;

type WalletHostActions = Readonly<{
  logout(): Promise<void> | void;
}>;

const listeners = new Set<() => void>();
let snapshot: Request | undefined;
let walletEvent: WalletEvent | undefined;
let fundingParent: Readonly<{ id: string; origin: string; source: Window }> | undefined;
let started = false;

export const parentDialog = Object.freeze({
  getRequest() {
    return snapshot;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async respond(result: unknown) {
    if (walletEvent) {
      const event = walletEvent;
      settle();
      await event.respond(result);
      return;
    }
    const current = fundingParent;
    if (!current) throw new Error("The Nanocodex dialog has no pending request");
    settle();
    current.source.postMessage({ type: "nanocodex:response", id: current.id, result }, current.origin);
  },
  async reject(error?: unknown) {
    const message = errorMessage(error);
    if (walletEvent) {
      const event = walletEvent;
      settle();
      await event.reject({ code: 4001, message });
      return;
    }
    const current = fundingParent;
    if (!current) throw new Error("The Nanocodex dialog has no pending request");
    settle();
    current.source.postMessage({
      type: "nanocodex:response",
      id: current.id,
      error: { message },
    }, current.origin);
  },
});

export function startWalletHost(actions: WalletHostActions) {
  if (started) return;
  started = true;
  const origin = parseOrigin(new URL(window.location.href).searchParams.get("origin"));
  if (!origin) return;
  const wata = Wata.create({ transports: [postMessage({ targetOrigin: origin })] });
  const session = wata.start();
  session.onRequest((event) => {
    if (event.request.method === "wallet_disconnect") {
      if (snapshot) {
        void event.reject({ code: -32002, message: "Nanocodex Connect already has a pending request." });
        return;
      }
      void Promise.resolve()
        .then(() => actions.logout())
        .then(() => event.respond(undefined))
        .catch((error) => event.reject({ code: -32603, message: errorMessage(error) }));
      return;
    }
    const type = event.request.method === "wallet_connect"
      ? "walletConnect"
      : event.request.method === "wallet_revokeAccessKey"
        ? "walletRevokeAccessKey"
        : undefined;
    if (snapshot || !type) {
      void event.reject({ code: -32601, message: "Nanocodex Connect only accepts connection, logout, and access-key revocation requests here." });
      return;
    }
    walletEvent = event as unknown as WalletEvent;
    publish(Object.freeze({
      id: crypto.randomUUID(),
      origin,
      rpc: event.request,
      type,
    }));
  });
  session.onNotification((event: Readonly<{ method: string }>) => {
    if (event.method === "cancel" && walletEvent) void parentDialog.reject();
  });
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    window.parent === window ||
    event.source !== window.parent ||
    event.origin === "null" ||
    snapshot !== undefined ||
    !isFundingMessage(event.data)
  ) return;

  fundingParent = Object.freeze({ id: event.data.id, origin: event.origin, source: window.parent });
  publish(Object.freeze(event.data.request));
});

function publish(request: Request | undefined) {
  snapshot = request;
  for (const listener of [...listeners]) listener();
}

function settle() {
  walletEvent = undefined;
  fundingParent = undefined;
  publish(undefined);
}

function parseOrigin(value: string | null) {
  if (!value) return undefined;
  try {
    const origin = new URL(value).origin;
    return origin === value ? origin : undefined;
  } catch {
    return undefined;
  }
}

function isFundingMessage(value: unknown): value is Readonly<{
  type: "nanocodex:request";
  id: string;
  request: Dialog.FundingRequest;
}> {
  if (!isRecord(value) || value.type !== "nanocodex:request" || typeof value.id !== "string") return false;
  return isRecord(value.request) && value.request.type === "machineUsdFund" && value.request.id === value.id;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "The request was not approved.";
}
