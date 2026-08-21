# nanocodex-react

React hooks over the headless browser SDK. The vanilla config owns the package
Worker, Rust/WASM Agent, persistent workspace, and cleanup. React only reads
that external state and binds event subscriptions.

```tsx
import { createConfig, NanocodexProvider, useAgent } from "nanocodex-react";

const config = createConfig();

root.render(
  <NanocodexProvider config={config}>
    <App />
  </NanocodexProvider>,
);

function App() {
  const { data: agent, error, isPending, refetch } = useAgent();
  // `agent` is the normal headless Agent from `nanocodex/browser`.
}
```

`useAgent({ threadId, enabled })` follows an external-store lifecycle: the
vanilla config creates one Agent for active subscribers, shares it, and shuts it
down after the last subscriber leaves. `useAgentEvents` is the narrow hook for
ordered typed events.

Create the config once, outside React. Applications can pass Agent defaults to
`createConfig({ agent: { ... } })` without adding another lifecycle owner.
