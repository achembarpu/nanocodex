# nanocodex-artifacts

Persistent live React source interfaces for Nanocodex applications.

```ts
import { ArtifactStore } from "nanocodex-artifacts";
import { open } from "nanocodex/browser/workspace";

const store = new ArtifactStore(await open({ name: "my-app" }));
const renderArtifact = store.tool((artifact) => showArtifact(artifact));

const agent = await Agent.create({
  filesystem: workspace,
  tools: { render_artifact: renderArtifact },
});
```

The `render_artifact` tool accepts a stable `id`, a `title`, and JavaScript
`source` that defines an `App` component. The application runtime provides
`React`, an `html` tagged-template helper, and `sendPrompt(prompt)`. Reusing an
ID replaces that interface in place, so an agent can continuously redesign and
extend it from voice or text instructions.

`ArtifactStore` depends only on the narrow structural subset of `Workspace`
used for persistence. Documents are structurally validated, while storage and
runtime capacity remain owned by the host; the binding adds no byte, source, or
document-count ceilings. There is no component catalog or JSON-to-UI rendering
contract.
