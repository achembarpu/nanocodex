import { describe, expect, it } from "vitest";

import {
  HOSTED_TOOL_CALL_TIMEOUT_MS,
  HOSTED_TOOLS_CAPABILITY,
  HOSTED_TOOLS_PROTOCOL_VERSION,
  MAX_HOSTED_TOOL_CATALOG_ENTRIES,
  MAX_HOSTED_TOOL_INPUT_BYTES,
  MAX_HOSTED_TOOL_OUTPUT_BYTES,
  MAX_HOSTED_TOOL_SCHEMA_BYTES,
  MAX_HOSTED_TOOLS_FRAME_BYTES,
  matchesHostedToolsLease,
  parseHostedToolsHostFrame,
  parseHostedToolsManagedFrame,
} from "../src/hosted-tools-protocol";

const HOST_ID = "01890f3e-65b2-7cc0-98c4-7f93b54e0a1d";
const LEASE_ID = "22222222-2222-4222-8222-222222222222";
const DIGEST = "d".repeat(64);

const base = {
  protocol_version: HOSTED_TOOLS_PROTOCOL_VERSION,
  capability: HOSTED_TOOLS_CAPABILITY,
} as const;

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function catalogEntry(name = "fixture__lookup") {
  return {
    provider: "fixture",
    remote_name: "lookup",
    definition: {
      type: "function",
      name,
      description: "Look up one fixture by identifier.",
      strict: true,
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    parallel_safe: true,
    summary: "Fixture lookup.",
    timeout_ms: HOSTED_TOOL_CALL_TIMEOUT_MS,
  };
}

function customCatalogEntry(name = "apply_patch") {
  return {
    provider: "workspace",
    remote_name: name,
    definition: {
      type: "custom",
      name,
      description: "Apply one grammar-constrained patch.",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/s",
      },
    },
    parallel_safe: false,
    timeout_ms: HOSTED_TOOL_CALL_TIMEOUT_MS,
  };
}

function completedOutput(output: unknown = "ok") {
  return {
    output,
    success: true,
    structured_result: { id: "item-1" },
    metadata: null,
    process_trace: null,
  };
}

describe("Hosted Tools reverse protocol v1", () => {
  it("parses the complete host-to-managed frame family", () => {
    expect(parseHostedToolsHostFrame(encode({
      ...base,
      type: "attach",
      host_id: HOST_ID,
      capabilities: [{ name: "tools", version: 1 }],
    }))).toEqual({
      ...base,
      type: "attach",
      host_id: HOST_ID,
      capabilities: [{ name: "tools", version: 1 }],
    });

    expect(parseHostedToolsHostFrame(encode({
      ...base,
      type: "catalog_publish",
      lease_id: LEASE_ID,
      generation: 7,
      catalog_revision: 3,
      catalog_digest: DIGEST,
      tools: [catalogEntry()],
    }))).toMatchObject({
      type: "catalog_publish",
      generation: 7,
      catalog_revision: 3,
      tools: [{ definition: { type: "function", name: "fixture__lookup" } }],
    });
    expect(parseHostedToolsHostFrame(encode({
      ...base,
      type: "catalog_publish",
      lease_id: LEASE_ID,
      generation: 7,
      catalog_revision: 4,
      catalog_digest: DIGEST,
      tools: [customCatalogEntry()],
    }))).toMatchObject({
      tools: [{ definition: { type: "custom", name: "apply_patch" } }],
    });

    expect(parseHostedToolsHostFrame(encode({
      ...base,
      type: "result",
      lease_id: LEASE_ID,
      generation: 7,
      catalog_revision: 3,
      call_id: "call:1",
      outcome: { status: "completed", output: completedOutput() },
    }))).toMatchObject({
      type: "result",
      call_id: "call:1",
      outcome: { status: "completed", output: { success: true } },
    });

    expect(parseHostedToolsHostFrame(encode({
      ...base,
      type: "cancel_ack",
      lease_id: LEASE_ID,
      generation: 7,
      catalog_revision: 3,
      call_id: "call:2",
      outcome: "too_late",
    }))).toMatchObject({ type: "cancel_ack", call_id: "call:2", outcome: "too_late" });

    expect(parseHostedToolsHostFrame(encode({
      ...base,
      type: "ping",
      lease_id: LEASE_ID,
      generation: 7,
      nonce: "heartbeat-7",
    }))).toEqual({
      ...base,
      type: "ping",
      lease_id: LEASE_ID,
      generation: 7,
      nonce: "heartbeat-7",
    });
  });

  it("parses the complete managed-to-host frame family", () => {
    expect(parseHostedToolsManagedFrame(encode({
      ...base,
      type: "lease",
      lease_id: LEASE_ID,
      generation: 8,
      expires_at: 20_000,
      capabilities: [{ name: "tools", version: 1 }],
    }))).toMatchObject({ type: "lease", generation: 8, expires_at: 20_000 });

    expect(parseHostedToolsManagedFrame(encode({
      ...base,
      type: "catalog_ack",
      lease_id: LEASE_ID,
      generation: 8,
      catalog_revision: 4,
      catalog_digest: DIGEST,
    }))).toMatchObject({ type: "catalog_ack", catalog_revision: 4 });

    expect(parseHostedToolsManagedFrame(encode({
      ...base,
      type: "call",
      host_id: HOST_ID,
      lease_id: LEASE_ID,
      generation: 8,
      catalog_revision: 4,
      session_id: "session:1",
      call_id: "call:3",
      model: "gpt-5.6-sol",
      name: "fixture__lookup",
      input: { id: "item-1" },
      output_token_budget: 10_000,
      output_byte_budget: 64 * 1024,
      deadline_at: 30_000,
    }))).toMatchObject({
      type: "call",
      host_id: HOST_ID,
      generation: 8,
      catalog_revision: 4,
      call_id: "call:3",
      name: "fixture__lookup",
      input: { id: "item-1" },
    });

    for (const type of ["cancel", "result_ack"] as const) {
      expect(parseHostedToolsManagedFrame(encode({
        ...base,
        type,
        lease_id: LEASE_ID,
        generation: 8,
        catalog_revision: 4,
        call_id: "call:3",
      }))).toMatchObject({ type, call_id: "call:3", catalog_revision: 4 });
    }

    expect(parseHostedToolsManagedFrame(encode({
      ...base,
      type: "pong",
      lease_id: LEASE_ID,
      generation: 8,
      expires_at: 40_000,
      nonce: "heartbeat-8",
    }))).toMatchObject({ type: "pong", expires_at: 40_000, nonce: "heartbeat-8" });

    expect(parseHostedToolsManagedFrame(encode({
      ...base,
      type: "fenced",
      lease_id: LEASE_ID,
      generation: 8,
      reason: "a newer attachment acquired the singleton lease",
    }))).toMatchObject({ type: "fenced", generation: 8 });
  });

  it("requires the v1 tools header and rejects cross-direction frames", () => {
    const attach = {
      ...base,
      type: "attach",
      host_id: HOST_ID,
      capabilities: [{ name: "tools", version: 1 }],
    };
    expect(() => parseHostedToolsHostFrame(encode({ ...attach, protocol_version: 2 })))
      .toThrow("unsupported Hosted Tools protocol version");
    expect(() => parseHostedToolsHostFrame(encode({ ...attach, capability: "other" })))
      .toThrow("unsupported Hosted Tools capability");
    expect(() => parseHostedToolsHostFrame(encode({ ...attach, credential: "rejected" })))
      .toThrow("unsupported fields");
    expect(() => parseHostedToolsManagedFrame(encode(attach)))
      .toThrow("not a managed-to-host tools frame");
    expect(() => parseHostedToolsHostFrame(encode({
      ...base,
      type: "lease",
      lease_id: LEASE_ID,
      generation: 1,
      expires_at: 20_000,
      capabilities: [{ name: "tools", version: 1 }],
    }))).toThrow("not a host-to-managed tools frame");
    expect(() => parseHostedToolsHostFrame(encode({
      ...attach,
      capabilities: [{ name: "tools", version: 2 }],
    }))).toThrow("require tools capability version 1");
  });

  it("enforces frame, catalog count, name, schema, and nested exact-key bounds", () => {
    expect(() => parseHostedToolsHostFrame("x".repeat(MAX_HOSTED_TOOLS_FRAME_BYTES + 1)))
      .toThrow("frames are limited");

    const publication = {
      ...base,
      type: "catalog_publish",
      lease_id: LEASE_ID,
      generation: 1,
      catalog_revision: 1,
      catalog_digest: DIGEST,
      tools: [catalogEntry()],
    };
    expect(() => parseHostedToolsHostFrame(encode({
      ...publication,
      tools: Array.from({ length: MAX_HOSTED_TOOL_CATALOG_ENTRIES + 1 }, () => catalogEntry()),
    }))).toThrow(`at most ${MAX_HOSTED_TOOL_CATALOG_ENTRIES}`);
    expect(() => parseHostedToolsHostFrame(encode({
      ...publication,
      tools: [catalogEntry("x".repeat(129))],
    }))).toThrow("tool name must be 1-128 safe ASCII bytes");
    for (const reserved of ["exec", "tool_search", "wait"]) {
      expect(() => parseHostedToolsHostFrame(encode({
        ...publication,
        tools: [catalogEntry(reserved)],
      }))).toThrow("tool name is reserved");
    }
    expect(() => parseHostedToolsHostFrame(encode({
      ...publication,
      tools: [catalogEntry(), { ...catalogEntry(), remote_name: "lookup_again" }],
    }))).toThrow("duplicate tool name");
    expect(() => parseHostedToolsHostFrame(encode({
      ...publication,
      tools: [{ ...catalogEntry(), definition: { ...catalogEntry().definition, extra: true } }],
    }))).toThrow("unsupported fields");
    expect(() => parseHostedToolsHostFrame(encode({
      ...publication,
      tools: [{
        ...catalogEntry(),
        definition: {
          ...catalogEntry().definition,
          parameters: { type: "object", description: "x".repeat(MAX_HOSTED_TOOL_SCHEMA_BYTES) },
        },
      }],
    }))).toThrow("parameters is limited");
    expect(() => parseHostedToolsHostFrame(encode({
      ...publication,
      catalog_digest: DIGEST.toUpperCase(),
    }))).toThrow("lowercase SHA-256 digest");
  });

  it("bounds calls and preserves all four terminal outcomes", () => {
    const result = {
      ...base,
      type: "result",
      lease_id: LEASE_ID,
      generation: 2,
      catalog_revision: 1,
      call_id: "call:terminal",
    };
    for (const status of ["unavailable", "ambiguous", "cancelled"] as const) {
      expect(parseHostedToolsHostFrame(encode({
        ...result,
        outcome: { status, message: `${status} outcome` },
      }))).toMatchObject({ outcome: { status, message: `${status} outcome` } });
    }
    expect(parseHostedToolsHostFrame(encode({
      ...result,
      outcome: {
        status: "completed",
        output: completedOutput([
          { type: "input_text", text: "done" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
          { type: "input_audio", audio_url: "data:audio/wav;base64,AA==" },
        ]),
      },
    }))).toMatchObject({ outcome: { status: "completed", output: { success: true } } });
    expect(() => parseHostedToolsHostFrame(encode({
      ...result,
      outcome: { status: "completed", output: { ...completedOutput(), extra: true } },
    }))).toThrow("unsupported fields");
    expect(() => parseHostedToolsHostFrame(encode({
      ...result,
      outcome: { status: "completed", output: completedOutput("x".repeat(MAX_HOSTED_TOOL_OUTPUT_BYTES)) },
    }))).toThrow("completed output is limited");

    const call = {
      ...base,
      type: "call",
      host_id: HOST_ID,
      lease_id: LEASE_ID,
      generation: 2,
      catalog_revision: 1,
      session_id: "session:2",
      call_id: "call:bounded",
      model: "gpt-5.6-sol",
      name: "fixture__lookup",
      input: { id: "item-2" },
      output_token_budget: 10_000,
      output_byte_budget: MAX_HOSTED_TOOL_OUTPUT_BYTES,
      deadline_at: 50_000,
    };
    expect(() => parseHostedToolsManagedFrame(encode({
      ...call,
      input: { payload: "x".repeat(MAX_HOSTED_TOOL_INPUT_BYTES) },
    }))).toThrow("call input is limited");
    expect(() => parseHostedToolsManagedFrame(encode({
      ...call,
      output_byte_budget: MAX_HOSTED_TOOL_OUTPUT_BYTES + 1,
    }))).toThrow("output_byte_budget");
    expect(() => parseHostedToolsManagedFrame(encode({ ...call, model: "x".repeat(129) })))
      .toThrow("model");
    expect(() => parseHostedToolsManagedFrame(encode({ ...call, input: [] })))
      .toThrow("call input must be an object");
    expect(parseHostedToolsManagedFrame(encode({
      ...call,
      name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
    }))).toMatchObject({ name: "apply_patch", input: "*** Begin Patch\n*** End Patch" });
  });

  it("matches only the active stable identity, generation, lease, and lifetime", () => {
    const state = {
      host_id: HOST_ID,
      lease_id: LEASE_ID,
      generation: 9,
      lease_expires_at: 20_000,
    };
    expect(matchesHostedToolsLease({
      hostId: HOST_ID,
      leaseId: LEASE_ID,
      generation: 9,
    }, state, 19_999)).toBe(true);
    expect(matchesHostedToolsLease({
      hostId: HOST_ID,
      leaseId: LEASE_ID,
      generation: 9,
    }, state, 20_000)).toBe(false);
    expect(matchesHostedToolsLease({
      hostId: HOST_ID,
      leaseId: LEASE_ID,
      generation: 8,
    }, state, 19_999)).toBe(false);
    expect(matchesHostedToolsLease({
      hostId: HOST_ID,
      leaseId: crypto.randomUUID(),
      generation: 9,
    }, state, 19_999)).toBe(false);
    expect(matchesHostedToolsLease({
      hostId: HOST_ID,
      leaseId: LEASE_ID,
      generation: 9,
    }, state, 20_001)).toBe(false);
  });
});

