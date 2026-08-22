import { describe, expect, it, vi } from "vitest";

import { handleAgent, type AgentEnv } from "../src/agent";

describe("standard managed-agent Worker", () => {
  it("authenticates public ingress before invoking its Service Binding", async () => {
    const fetch = vi.fn(async () => Response.json({ unexpected: true }));
    const response = await handleAgent(
      new Request("https://agent.example/blocked"),
      agentEnv(fetch),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only the fixed Codex route and placeholders through the binding", async () => {
    let observed: Request | undefined;
    const response = await handleAgent(
      new Request("https://agent.example/codex-handshake", {
        method: "POST",
        headers: { authorization: "Bearer agent-secret" },
      }),
      agentEnv(async (input, init) => {
        observed = input instanceof Request ? input : new Request(input, init);
        return Response.json({ error: "upstream_rejected" }, { status: 403 });
      }),
    );

    expect(response.status).toBe(502);
    expect(observed?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(observed?.headers.get("authorization")).toBe("Bearer NANOCODEX_CODEX_OAUTH");
    expect(observed?.headers.get("chatgpt-account-id")).toBe("NANOCODEX_CODEX_ACCOUNT");
    expect(observed?.headers.get("upgrade")).toBe("websocket");
  });

  it("returns an unmatched request denial from the private broker", async () => {
    let observed: Request | undefined;
    const response = await handleAgent(
      new Request("https://agent.example/blocked", {
        headers: { authorization: "Bearer agent-secret" },
      }),
      agentEnv(async (input, init) => {
        observed = input instanceof Request ? input : new Request(input, init);
        return Response.json(
          { error: "destination_denied" },
          { status: 403, headers: { "cache-control": "no-store" } },
        );
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "destination_denied" });
    expect(observed?.url).toBe("https://example.com/");
  });
});

function agentEnv(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): AgentEnv {
  return {
    AGENT_TOKEN: "agent-secret",
    EGRESS: { fetch } as unknown as Fetcher,
  };
}
