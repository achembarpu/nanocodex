import { fileURLToPath } from "node:url";

const connectDialogModulePrefix = "/connect-dialog/src/";
const connectDialogSourceRoot = new URL("../connect-dialog/src/", import.meta.url);

/**
 * Keeps source modules shared with the Connect dialog inside Vite's module
 * graph during development. The production Worker owns the public
 * /connect-dialog mount, so an unqualified module URL at that prefix would be
 * mistaken for a request to the separately deployed dialog application.
 */
export function rewriteConnectDialogDevModuleUrl(requestUrl: string | undefined) {
  if (requestUrl == null) return undefined;
  let url: URL;
  try {
    url = new URL(requestUrl, "https://localhost");
  } catch {
    return undefined;
  }
  if (!url.pathname.startsWith(connectDialogModulePrefix)) return undefined;

  const encodedRelative = url.pathname.slice(connectDialogModulePrefix.length);
  let relative: string;
  try {
    relative = decodeURIComponent(encodedRelative);
  } catch {
    return undefined;
  }
  if (
    relative.startsWith("/")
    || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) return undefined;

  const absolute = fileURLToPath(new URL(relative, connectDialogSourceRoot));
  return `/@fs${absolute}${url.search}`;
}
