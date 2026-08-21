import React from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import {
  modalFrameBoundaryMessage,
  modalFrameBoundaryReadyMessage,
  modalFrameTabBoundaryKey,
  readModalFrameBoundaryState,
} from "./artifactModalBoundary";
import {
  deepActiveElement,
  modalFocusableElements,
} from "./modalBoundary";

const html = htm.bind(React.createElement);
document.documentElement.classList.add("artifact-runtime-page");
const container = document.getElementById("root");
if (!container) throw new Error("artifact runtime root is missing");
const root = createRoot(container);
let artifactId = "";
let modalBoundaryActive = false;

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const boundaryState = readModalFrameBoundaryState(event.data);
  if (boundaryState !== undefined) {
    modalBoundaryActive = boundaryState;
    return;
  }
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
window.parent.postMessage(modalFrameBoundaryReadyMessage(), "*");

window.addEventListener("keydown", (event) => {
  if (window.parent === window || !modalBoundaryActive) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    window.parent.postMessage(modalFrameBoundaryMessage("Escape"), "*");
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = modalFocusableElements(document);
  const active = deepActiveElement(document);
  const key = modalFrameTabBoundaryKey({
    activeIndex: focusable.findIndex((element) => element === active),
    focusableCount: focusable.length,
    shiftKey: event.shiftKey,
  });
  if (!key) return;
  event.preventDefault();
  event.stopPropagation();
  window.parent.postMessage(modalFrameBoundaryMessage(key), "*");
}, { capture: true });

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
