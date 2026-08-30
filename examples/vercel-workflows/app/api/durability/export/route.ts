import { durabilityRevision, exportDurabilityStatePage } from "nanocodex/durability";

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
    const body = await request.json() as {
      state_id?: unknown;
      from?: unknown;
      to?: unknown;
      cursor?: unknown;
      limit?: unknown;
    };
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["state_id", "from", "to", "cursor", "limit"].includes(key))
      || typeof body.state_id !== "string" || !body.state_id.trim()
      || (typeof body.from !== "string" && typeof body.from !== "number")
      || (body.to !== undefined && typeof body.to !== "string" && typeof body.to !== "number")
      || (body.cursor !== undefined && typeof body.cursor !== "string")
      || (body.limit !== undefined && typeof body.limit !== "number")) {
      return Response.json(
        { error: { code: "invalid_request", message: "state_id and from are required" } },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      await exportDurabilityStatePage(postgresDurabilityStore(), body.state_id, {
        from: durabilityRevision(body.from),
        to: body.to === undefined ? undefined : durabilityRevision(body.to),
        cursor: body.cursor,
        limit: body.limit,
      }),
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
