import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nanocodexActor: vi.fn(),
  start: vi.fn(),
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/nanocodex-actor", () => ({
  nanocodexActor: mocks.nanocodexActor,
}));

import { POST } from "../app/api/sessions/route";
import { nanocodexActor } from "../workflows/nanocodex-actor";

const originalAdminToken = process.env.NANOCODEX_ADMIN_TOKEN;

describe("session creation route", () => {
  beforeEach(() => {
    delete process.env.NANOCODEX_ADMIN_TOKEN;
    mocks.start.mockReset();
  });

  afterEach(() => {
    if (originalAdminToken === undefined) delete process.env.NANOCODEX_ADMIN_TOKEN;
    else process.env.NANOCODEX_ADMIN_TOKEN = originalAdminToken;
  });

  it("uses the Workflow run ID as the only public session identity", async () => {
    mocks.start.mockResolvedValue({ runId: "wrun_canonical" });

    const response = await POST(new Request("https://example.test/api/sessions", {
      method: "POST",
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ session_id: "wrun_canonical" });
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith(mocks.nanocodexActor);
  });

  it("accepts no compatibility session argument at the actor boundary", () => {
    expectTypeOf(nanocodexActor).toEqualTypeOf<() => Promise<never>>();
  });
});
