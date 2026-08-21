import { start } from "workflow/api";

import { hasBearerToken } from "@/lib/bearer-auth";
import { nanocodexActor } from "@/workflows/nanocodex-actor";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!authorizedToCreate(request)) {
    return Response.json(
      { error: { code: "unauthorized", message: "session creation token was rejected" } },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const run = await start(nanocodexActor);
    return Response.json(
      { session_id: run.runId },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: { code: "session_start_failed", message } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

function authorizedToCreate(request: Request): boolean {
  const expected = process.env.NANOCODEX_ADMIN_TOKEN?.trim();
  if (!expected) return true;
  return hasBearerToken(request, expected);
}
