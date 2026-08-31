export const CHROME_EXTENSION_APP_ID = "nanocodex-chrome";
export const CHROME_EXTENSION_ORIGIN = "chrome-extension://jpkimkgbgbpcaldbnhlhbkbadmpeffle";
export const CHROME_CLEANUP_APP_TOOL_POLICY = "nanocodex-chrome-cleanup-v1";

export function connectAppToolPolicy(app) {
  return app?.appId === CHROME_EXTENSION_APP_ID
    && app?.origin === CHROME_EXTENSION_ORIGIN
    ? CHROME_CLEANUP_APP_TOOL_POLICY
    : undefined;
}
