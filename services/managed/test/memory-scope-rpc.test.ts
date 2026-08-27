import { describe, expect, it, vi } from "vitest";

import { withAiSearchItem } from "../src/memory-scope";

describe("AI Search item RPC ownership", () => {
  it("disposes the retained item stub after a successful operation", async () => {
    const dispose = vi.fn();
    const info = Object.freeze({ id: "item-1", status: "completed" });
    const item = {
      info: vi.fn(async () => info),
      [Symbol.dispose]: dispose,
    };
    const items = {
      get: vi.fn(() => item),
    } as unknown as Pick<AiSearchItems, "get">;

    await expect(withAiSearchItem(items, "item-1", (current) => current.info()))
      .resolves.toBe(info);
    expect(items.get).toHaveBeenCalledExactlyOnceWith("item-1");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes the retained item stub when the operation fails", async () => {
    const dispose = vi.fn();
    const item = {
      info: vi.fn(async () => { throw new Error("AI Search unavailable"); }),
      [Symbol.dispose]: dispose,
    };
    const items = {
      get: vi.fn(() => item),
    } as unknown as Pick<AiSearchItems, "get">;

    await expect(withAiSearchItem(items, "item-2", (current) => current.info()))
      .rejects.toThrow("AI Search unavailable");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes the retained item stub after requesting a resync", async () => {
    const dispose = vi.fn();
    const synced = Object.freeze({ id: "item-3", status: "pending" });
    const item = {
      sync: vi.fn(async () => synced),
      [Symbol.dispose]: dispose,
    };
    const items = {
      get: vi.fn(() => item),
    } as unknown as Pick<AiSearchItems, "get">;

    await expect(withAiSearchItem(items, "item-3", (current) => current.sync()))
      .resolves.toBe(synced);
    expect(item.sync).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
