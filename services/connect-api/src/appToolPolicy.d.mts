export const CHROME_EXTENSION_APP_ID: "nanocodex-chrome";
export const CHROME_EXTENSION_ORIGIN: "chrome-extension://jpkimkgbgbpcaldbnhlhbkbadmpeffle";
export const CHROME_CLEANUP_APP_TOOL_POLICY: "nanocodex-chrome-cleanup-v1";

export function connectAppToolPolicy(
  app: Readonly<{ appId: string; origin: string }>,
): typeof CHROME_CLEANUP_APP_TOOL_POLICY | undefined;
