# nanocodex-react

React hooks over the headless browser SDK. The vanilla config owns the package
Worker, Rust/WASM Agent, persistent workspace, and cleanup. React only reads
that external state and binds event subscriptions.

```tsx
import { createConfig, useNanocodex } from "nanocodex-react";

const config = createConfig();

function App() {
  const { data: agent, error, isPending, refetch } = useNanocodex({ config });
  // `agent` is the normal headless Agent from `nanocodex/browser`.
}

root.render(<App />);
```

`useNanocodex({ config, threadId, enabled })` follows an external-store lifecycle: the
vanilla config creates one Agent for active subscribers, shares it, and shuts it
down after the last subscriber leaves. Disabled hooks stay idle and do not
prepare or create an Agent. Omitted and empty thread IDs resolve to one stable
config-owned default, including across React remounts. Server rendering always
observes the idle snapshot and then reconciles with the live client resource.

Components that need only part of the resource can select it without rerendering
for unrelated state changes:

```tsx
const sessionId = useNanocodex({
  config,
  selector: (resource) => resource.data?.sessionId,
  equalityFn: Object.is,
});
```

Without a selector, `useNanocodex` returns the full query-like resource shown above.
`useAgentEvents` is the narrow hook for ordered typed events.

`useVoice` is the thin React adapter over the Rust/WASM-owned Codex voice
resource:

```tsx
const { data: agent } = useNanocodex({ config, threadId });
const voice = useVoice(agent);

return (
  <button disabled={!agent} onClick={() => void voice.toggle()}>
    {voice.isActive ? `Voice (${voice.voice})` : "Voice"}
  </button>
);
```

Unmounting or replacing the Agent closes voice media and the Realtime session.
Call `voice.cancel()` separately when the user intends to cancel the active
coding turn.

Create the config once, outside React. Applications with many consumers can put
it in `NanocodexProvider` and omit `config` from each hook. Agent defaults belong
in `createConfig({ agent: { ... } })`; React does not need a separate preload or
preparation lifecycle.

```ts
const config = createConfig({ agent: { /* tools and policy */ } });
```
