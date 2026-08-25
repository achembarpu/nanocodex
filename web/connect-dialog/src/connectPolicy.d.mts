export const productionConnectApiOrigin: "https://nanocodex-connect-api.gakonst.workers.dev";

export type RegisteredApp = Readonly<{
  id: string;
  name: string;
  origin: string;
}>;

export function registeredApp(
  embeddingOrigin: string,
  appId: string,
  dialogUrl: string,
  isTopLevel: boolean,
  allowDynamicPopup?: boolean,
): RegisteredApp;
export function isPopupPresentation(dialogUrl: string, isTopLevel: boolean): boolean;
export function signedAppResources(resources: unknown, app: RegisteredApp): readonly unknown[];
export function connectApiOrigin(auth: unknown, dialogOrigin: string): string;
export function sanitizeWalletResult(result: unknown): Readonly<{
  accounts: readonly Readonly<{
    address?: unknown;
    capabilities: Readonly<Record<string, unknown> & {
      auth: Readonly<{ approval_id: string }>;
    }>;
  }>[];
}> & Record<string, unknown>;
export function appVisibilityPermissions(resources: unknown): readonly Readonly<{
  resource: string;
  label: "Reply" | "Actions" | "History" | "Traces";
  detail: string;
}>[];
export function accountLoginCapabilities(accounts: unknown): Readonly<
  | { method: "login"; credentialId: readonly string[] }
  | { method: "login" }
>;
export function isLocalDevelopmentOrigin(value: string): boolean;
export function usesBrowserLocalWebAuthn(value: string): boolean;
