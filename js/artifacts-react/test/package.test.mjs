import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactRenderer, defaultArtifactComponents } from "nanocodex-artifacts-react";

const artifact = {
  version: 1,
  id: "demo",
  title: "Demo",
  createdAt: 1,
  updatedAt: 1,
  spec: {
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["metric", "chart", "button"] },
      metric: { type: "Metric", props: { label: "Value", value: "42" } },
      chart: { type: "BarChart", props: { data: [{ label: "A", value: 42 }] } },
      button: { type: "Button", props: { label: "Continue", prompt: "Continue" } },
    },
  },
};

const html = renderToStaticMarkup(createElement(ArtifactRenderer, { artifact }));
assert.match(html, /data-artifact-id="demo"/);
assert.match(html, /role="img"/);
assert.match(html, /Value/);
assert.equal(Object.keys(defaultArtifactComponents).length, 16);

const overridden = renderToStaticMarkup(createElement(ArtifactRenderer, {
  artifact,
  components: {
    Metric: ({ props }) => createElement("output", { "data-custom-metric": true }, props.value),
  },
}));
assert.match(overridden, /data-custom-metric="true"/);
