import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Sandbox,
  handleSandboxEgress,
} from "../src/sandbox-runtime";

afterEach(() => vi.unstubAllGlobals());

describe("sandbox runtime egress", () => {
  it("installs the managed policy as the catch-all outbound handler", () => {
    expect(Sandbox.outbound).toBe(handleSandboxEgress);
  });

  it("allows policy-validated public HTTPS without using account credentials", async () => {
    const upstream = vi.fn(async () => new Response("ok", {
      headers: { "content-type": "text/plain" },
    }));
    vi.stubGlobal("fetch", upstream);
    const broker = { fetch: vi.fn() } as unknown as Fetcher;

    const response = await handleSandboxEgress(
      new Request("https://github.com/dtolnay/anyhow.git/info/refs?service=git-upload-pack", {
        headers: { host: "github.com" },
      }),
      { NANOCODEX: broker },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(broker.fetch).not.toHaveBeenCalled();
  });

  it("rejects account connector destinations and private network targets", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const broker = { fetch: vi.fn() } as unknown as Fetcher;

    expect((await handleSandboxEgress(
      new Request("https://api.github.com/user"),
      { NANOCODEX: broker },
    )).status).toBe(403);
    expect((await handleSandboxEgress(
      new Request("http://127.0.0.1:8787/secret"),
      { NANOCODEX: broker },
    )).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(broker.fetch).not.toHaveBeenCalled();
  });
});
