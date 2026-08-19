import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("browser demo", () => {
  it("uses resumable WebSockets and synchronizes only client-safe state", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    expect(source).toContain("new WebSocket");
    expect(source).toContain("startIndex");
    expect(source).toContain("stream_event");
    expect(source).toContain("window.addEventListener(\"storage\"");
    expect(source).toContain("assistant.delta");
    expect(source).toContain("nanocodex:workflow-session");
    expect(source).not.toContain("CHATGPT_ACCESS_TOKEN");
    expect(source).not.toContain("OPENAI_API_KEY");
    expect(source).not.toContain("cloud_api_");
  });

  it("keeps the PTY attachment separate from the replayable agent stream", async () => {
    const terminal = await readFile(
      new URL("../app/workspace-terminal.tsx", import.meta.url),
      "utf8",
    );
    expect(terminal).toContain("terminalStartFrame");
    expect(terminal).toContain("terminalInputFrame");
    expect(terminal).toContain("NANOCODEX_TERMINAL_TOKEN");
    expect(terminal).not.toContain("startIndex");
    expect(terminal).not.toContain("stream_event");
  });

  it("keeps model credentials behind the server-side workflow step", async () => {
    const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
    const workflow = await readFile(
      new URL("../workflows/nanocodex-actor.ts", import.meta.url),
      "utf8",
    );
    expect(page).toContain("Model credentials remain");
    expect(workflow).toContain('"use workflow"');
    expect(workflow).toContain('"use step"');
    expect(workflow).toContain("getWritable<SessionEvent>");
  });
});
