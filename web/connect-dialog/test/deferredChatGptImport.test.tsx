import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeferredChatGptImportCard,
  DeferredChatGptImportStatus,
  chatGptCredentialImportAction,
  chatGptCredentialImportApproved,
  chatGptCredentialImportHelper,
} from "../src/AccountConnectionSurface";

afterEach(() => vi.unstubAllGlobals());

describe("deferred ChatGPT credential import", () => {
  it("renders the shared connection card as a non-interactive Codex import", () => {
    const fetchHook = vi.fn();
    const popupHook = vi.fn();
    vi.stubGlobal("fetch", fetchHook);
    vi.stubGlobal("window", { open: popupHook });

    const markup = renderToStaticMarkup(<DeferredChatGptImportCard />);

    expect(markup).toContain("connection-card");
    expect(markup).toContain("disabled");
    expect(markup).toContain(chatGptCredentialImportAction);
    expect(markup).toContain(chatGptCredentialImportHelper);
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("device code");
    expect(markup).not.toContain("verification_url");
    expect(fetchHook).not.toHaveBeenCalled();
    expect(popupHook).not.toHaveBeenCalled();
  });

  it("renders only the terminal handoff after wallet approval", () => {
    const markup = renderToStaticMarkup(<DeferredChatGptImportStatus approved />);

    expect(markup).toBe(chatGptCredentialImportApproved);
    expect(markup).not.toContain(chatGptCredentialImportHelper);
  });
});
