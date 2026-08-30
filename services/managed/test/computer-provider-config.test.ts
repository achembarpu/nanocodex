import { describe, expect, it } from "vitest";

import { configuredComputerProvider } from "../src/computer-provider-config";

describe("managed compute provider configuration", () => {
  it("stays virtual when no provider is configured", () => {
    expect(configuredComputerProvider({}, "thread-1")).toBeUndefined();
  });

  it("fails closed when ix is selected without broker credentials", () => {
    expect(() => configuredComputerProvider({
      NANOCODEX_COMPUTE_PROVIDER: "ix",
    }, "thread-1")).toThrow("NANOCODEX_IX_BROKER_TOKEN");

    expect(() => configuredComputerProvider({
      NANOCODEX_COMPUTE_PROVIDER: "ix",
      NANOCODEX_IX_BROKER_TOKEN: "secret",
    }, "thread-1")).toThrow("NANOCODEX_IX_BROKER_URL");
  });

  it("constructs ix lazily without contacting the broker", () => {
    const factory = configuredComputerProvider({
      NANOCODEX_COMPUTE_PROVIDER: "ix",
      NANOCODEX_IX_BROKER_TOKEN: "secret",
      NANOCODEX_IX_BROKER_URL: "https://ix-broker.example.test",
      NANOCODEX_IX_REGION: "us-west-1",
    }, "018f.foo:bar");

    expect(factory).toBeTypeOf("function");
    const workspace = {
      root: "/workspace",
      async list() { return []; },
      async readFile() { throw new Error("missing"); },
      async writeFile() {},
      async mkdir() {},
      async remove() {},
    };
    expect(factory!(workspace)).toMatchObject({ exec: expect.any(Function) });
  });

  it("requires the Cloudflare Sandbox binding when cloudflare is selected", () => {
    expect(() => configuredComputerProvider({
      NANOCODEX_COMPUTE_PROVIDER: "cloudflare",
    }, "thread-1")).toThrow("NANOCODEX_COMPUTE_SANDBOX");
  });
});
