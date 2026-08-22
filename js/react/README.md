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
down after the last subscriber leaves. Disabled hooks stay idle and do not
prepare or create an Agent. Omitted and empty thread IDs resolve to one stable
config-owned default, including across React remounts. Server rendering always
observes the idle snapshot and then reconciles with the live client resource.

Components that need only part of the resource can select it without rerendering
for unrelated state changes:

```tsx
const sessionId = useAgent({
  selector: (resource) => resource.data?.sessionId,
  equalityFn: Object.is,
});
```

Without a selector, `useAgent` returns the full query-like resource shown above.
`useAgentEvents` is the narrow hook for ordered typed events.

Create the config once, outside React. Applications can pass Agent defaults to
`createConfig({ agent: { ... } })` without adding another lifecycle owner.

An authenticated route loader may hide Worker startup and WASM compilation
before React mounts without creating an Agent:

```ts
await config.prepareAgent({ threadId });
```
