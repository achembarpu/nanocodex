import { describe, expect, it, vi } from "vitest";

import { connectorEgressInfo } from "../src/connector-capabilities";

describe("connector egress capabilities", () => {
  it("reports authenticated connector names and display labels only", async () => {
    const fetch = vi.fn(async () => Response.json({
      connectors: {
        github: { connected: true, account_id: "secret-account", label: "Nano Cat (nanocat)" },
        gmail: { connected: false },
        gdrive: { connected: true, access_token: "secret-token" },
      },
    }));

    const info = await connectorEgressInfo({ fetch }, "user/with spaces", true);

    expect(info).toEqual({
      status: "ready",
      authenticated: ["github", "gdrive"],
      accounts: { github: "Nano Cat (nanocat)" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://broker.internal/users/user%2Fwith%20spaces/connectors",
    );
    expect(JSON.stringify(info)).not.toMatch(/secret-account|secret-token/);
  });

  it("fails closed when status is unavailable or malformed", async () => {
    expect(await connectorEgressInfo({
      fetch: async () => Response.json({ error: "down" }, { status: 503 }),
    }, "user", true)).toEqual({ status: "unavailable", authenticated: [], accounts: {} });
    expect(await connectorEgressInfo({
      fetch: async () => Response.json({ connectors: null }),
    }, "user", true)).toEqual({ status: "unavailable", authenticated: [], accounts: {} });
  });

  it("does not query account connectors for shared rooms", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    expect(await connectorEgressInfo({ fetch }, "owner", false)).toEqual({
      status: "disabled",
      authenticated: [],
      accounts: {},
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
