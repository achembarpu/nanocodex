import { timingSafeEqual } from "node:crypto";

import { RequestError } from "./validation";

export function requireTerminalAuthorization(
  request: Request,
  configuredToken = process.env.NANOCODEX_TERMINAL_TOKEN?.trim(),
): void {
  if (!configuredToken) {
    throw new RequestError(
      "terminal_disabled",
      "workspace terminal is disabled; configure NANOCODEX_TERMINAL_TOKEN",
      503,
    );
  }

  const header = request.headers.get("authorization");
  const suppliedToken = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  const configured = Buffer.from(configuredToken);
  const supplied = Buffer.from(suppliedToken);
  if (
    supplied.length !== configured.length ||
    !timingSafeEqual(supplied, configured)
  ) {
    throw new RequestError(
      "terminal_unauthorized",
      "workspace terminal token was rejected",
      401,
    );
  }
}
