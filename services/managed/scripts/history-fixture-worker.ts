interface Env {
  LOADER_TOKEN: string;
  NANOCODEX_MEMORY: DurableObjectNamespace;
}

const ORGANIZATION_HEADER = "x-nanocodex-organization-id";
const TEAM_HEADER = "x-nanocodex-team-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST"
      || request.headers.get("authorization") !== `Bearer ${env.LOADER_TOKEN}`) {
      return new Response(null, { status: 404 });
    }
    const body = await request.json<{
      organization_id?: unknown;
      team_id?: unknown;
      operation?: unknown;
      projections?: unknown;
      thread_ids?: unknown;
      verify_query?: unknown;
    }>();
    if (typeof body.organization_id !== "string" || !UUID.test(body.organization_id)
      || typeof body.team_id !== "string" || !UUID.test(body.team_id)) {
      return Response.json({ error: "invalid_scope" }, { status: 400 });
    }
    const memory = env.NANOCODEX_MEMORY.getByName(body.organization_id);
    const initialized = await memory.fetch("https://memory.internal/initialize", {
      method: "PUT",
      headers: { [ORGANIZATION_HEADER]: body.organization_id },
    });
    if (!initialized.ok) return new Response(initialized.body, initialized);
    if (body.operation === "project" && Array.isArray(body.projections)
      && body.projections.length > 0 && body.projections.length <= 64) {
      for (const projection of body.projections) {
        const response = await memory.fetch("https://memory.internal/project", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [ORGANIZATION_HEADER]: body.organization_id,
            [TEAM_HEADER]: body.team_id,
          },
          body: JSON.stringify(projection),
        });
        if (!response.ok) return new Response(response.body, response);
      }
      let verification: unknown;
      if (typeof body.verify_query === "string") {
        const response = await memory.fetch("https://memory.internal/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [ORGANIZATION_HEADER]: body.organization_id,
            [TEAM_HEADER]: body.team_id,
          },
          body: JSON.stringify({ query: body.verify_query, limit: 8 }),
        });
        if (!response.ok) return new Response(response.body, response);
        verification = await response.json();
      }
      return Response.json({ projected: body.projections.length, verification });
    }
    if (body.operation === "delete" && Array.isArray(body.thread_ids)
      && body.thread_ids.length > 0 && body.thread_ids.length <= 64
      && body.thread_ids.every((id) => typeof id === "string" && THREAD_ID.test(id))) {
      for (const threadId of body.thread_ids) {
        const response = await memory.fetch(`https://memory.internal/threads/${threadId}`, {
          method: "DELETE",
          headers: {
            [ORGANIZATION_HEADER]: body.organization_id,
            [TEAM_HEADER]: body.team_id,
          },
        });
        if (!response.ok) return new Response(response.body, response);
      }
      return Response.json({ deleted: body.thread_ids.length });
    }
    return Response.json({ error: "invalid_operation" }, { status: 400 });
  },
} satisfies ExportedHandler<Env>;
