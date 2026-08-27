import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpConnectionAddCard,
  McpConnectionCard,
  shortMcpConnectionIdentifier,
} from "../src/AccountConnectionSurface";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const connectionId = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const connection = {
  id: connectionId,
  name: "Linear workspace",
  status: "connected",
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("shared MCP connection card", () => {
  it("shows a shortened ID and copies the exact secret-free identifier with on-page confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<McpConnectionCard connection={connection} />);
    });

    const initial = JSON.stringify(renderer.toJSON());
    expect(initial).toContain(shortMcpConnectionIdentifier(connectionId));
    expect(initial).not.toContain(connectionId);

    await act(async () => {
      renderer.root.findByProps({ className: "mcp-copy-identifier" }).props.onClick();
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(connectionId);
    expect(JSON.stringify(renderer.toJSON())).toContain("Copied identifier");
  });

  it("keeps the Account card action independent and reports clipboard failure in place", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard unavailable"));
    const onAction = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <McpConnectionCard
          action="Disconnect"
          connection={connection}
          error="The MCP provider could not complete authorization."
          onAction={onAction}
          presentation="account"
        />,
      );
    });

    const card = renderer.root.findByProps({ role: "listitem" });
    expect(card.props.className).toContain("connection-card");
    expect(JSON.stringify(renderer.toJSON())).toContain("The MCP provider could not complete authorization.");
    const buttons = renderer.root.findAllByType("button");
    expect(buttons).toHaveLength(2);

    await act(async () => buttons[0]?.props.onClick());
    expect(JSON.stringify(renderer.toJSON())).toContain("Copy failed");
    expect(onAction).not.toHaveBeenCalled();

    await act(async () => buttons[1]?.props.onClick());
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("accepts Linear shorthand or an endpoint without duplicating server target validation", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<McpConnectionAddCard onSubmit={onSubmit} />);
    });

    const input = renderer.root.findByType("input");
    expect(input.props.type).toBe("text");
    expect(input.props.placeholder).toContain("mcp.linear.app");
    expect(input.props.required).toBe(true);

    await act(async () => {
      input.props.onChange({ target: { value: "mcp.linear.app" } });
    });
    await act(async () => {
      renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });

    expect(onSubmit).toHaveBeenCalledWith("mcp.linear.app");
    expect(renderer.root.findByType("input").props.value).toBe("");
  });
});
