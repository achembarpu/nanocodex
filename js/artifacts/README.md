# nanocodex-artifacts

Framework-independent, validated JSON artifacts for Nanocodex applications.

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

`ArtifactStore` depends only on the narrow structural subset of `Workspace` used for persistence, so browser, Node, and remote workspace implementations can share it. Documents are byte-bounded, strictly validated, and contain declarative data only.
