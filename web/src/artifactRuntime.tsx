import React from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";

const html = htm.bind(React.createElement);
const container = document.getElementById("root");
if (!container) throw new Error("artifact runtime root is missing");
const root = createRoot(container);
let artifactId = "";

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const value = asRecord(event.data);
  if (value?.type !== "render-artifact" || typeof value.source !== "string" || typeof value.artifactId !== "string") return;
  artifactId = value.artifactId;
  try {
    const sendPrompt = (prompt: unknown) => {
      if (typeof prompt !== "string" || !prompt.trim()) return;
      window.parent.postMessage({ type: "artifact-action", artifactId, prompt }, "*");
    };
    const factory = new Function(
      "React",
      "html",
      "sendPrompt",
      `"use strict";\n${value.source}\n;return typeof App === "function" ? App : undefined;`,
    );
    const App = factory(React, html, sendPrompt) as React.ComponentType<{ sendPrompt(prompt: string): void }> | undefined;
    if (!App) throw new TypeError("generated source must define an App component");
    root.render(React.createElement(App, { sendPrompt }));
  } catch (error) {
    root.render(React.createElement(RuntimeError, { error: errorMessage(error) }));
  }
});

window.parent.postMessage({ type: "artifact-runtime-ready" }, "*");

window.addEventListener("error", (event) => {
  root.render(React.createElement(RuntimeError, { error: event.message || "generated React failed" }));
});

function RuntimeError({ error }: { error: string }) {
  return <main className="runtime-error"><strong>Generated React failed</strong><pre>{error}</pre></main>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
