import { exportDurabilityState } from "nanocodex/durability";

import { hasBearerToken } from "@/lib/bearer-auth";
import { postgresDurabilityStore } from "@/workflows/postgres-durability";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.NANOCODEX_ADMIN_TOKEN?.trim();
  if (expected && !hasBearerToken(request, expected)) {
    return Response.json(
      { error: { code: "unauthorized", message: "durability export token was rejected" } },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const body = await request.json() as { state_id?: unknown };
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "state_id")
      || typeof body.state_id !== "string" || !body.state_id.trim()) {
      return Response.json(
        { error: { code: "invalid_request", message: "state_id is required" } },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      await exportDurabilityState(postgresDurabilityStore(), body.state_id),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: { code: "durability_export_failed", message } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
