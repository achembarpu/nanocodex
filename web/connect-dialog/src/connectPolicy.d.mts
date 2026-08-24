export const productionConnectApiOrigin: "https://nanocodex-connect-api.gakonst.workers.dev";

export type RegisteredApp = Readonly<{
  id: "atlas-workspace";
  name: "Atlas Workspace";
  origin: string;
}>;

export function registeredApp(embeddingOrigin: string, dialogOrigin: string): RegisteredApp;
export function connectApiOrigin(auth: unknown, dialogOrigin: string): string;
export function sanitizeWalletResult(result: unknown): Readonly<{
  accounts: readonly Readonly<{
    address?: unknown;
    capabilities: Readonly<Record<string, unknown> & {
      auth: Readonly<{ approval_id: string }>;
    }>;
  }>[];
}> & Record<string, unknown>;
export function isLoopbackOrigin(value: string): boolean;
