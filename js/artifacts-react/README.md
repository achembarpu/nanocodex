# nanocodex-artifacts-react

Accessible React rendering primitives for `nanocodex-artifacts`.

```tsx
import { ArtifactRenderer } from "nanocodex-artifacts-react";
import "nanocodex-artifacts-react/styles.css";

<ArtifactRenderer
  artifact={artifact}
  readFile={(path) => workspace.readFile(path)}
  onAction={(prompt) => queuePrompt(prompt)}
/>
```

The default 16-component catalog has no runtime dependencies beyond React. Each
primitive is also exported by name (`ArtifactCard`, `ArtifactTable`,
`ArtifactBarChart`, and so on). Applications can replace any registry entry
through the `components` prop and theme the defaults with `--nc-artifact-*` CSS
variables. Charts are dependency-free SVG, images use an injected file reader,
and action buttons use an injected callback.
