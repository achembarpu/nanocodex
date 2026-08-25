# nanocodex-terminal

Reusable React presentation for Nanocodex conversations. The package renders the
same semantic transcript and native composer used by the Nanocodex website. It
does not create an Agent, own credentials, choose a transport, or retain history.

```tsx
import {
  AgentTerminalView,
  TerminalComposer,
  TerminalTranscriptSurface,
} from "nanocodex-terminal";
import "nanocodex-terminal/styles.css";
```

`AgentTerminalView` is the complete controller-backed component. It accepts a
structural `Agent` from `nanocodex-react/agent` but never creates one or chooses
its runtime, transport, credentials, or persistence policy. It forwards
`maxEntries` to the canonical controller and supports `showToolCalls` without
changing retained state.

`TerminalTranscriptSurface` and `TerminalComposer` are lower-level controlled
pieces for consumers that already own their controller composition. The
transcript accepts `followTailRequest` for explicit submit-to-tail behavior and
`showToolCalls` for surfaces that intentionally hide tool activity.
The stylesheet consumes optional `--terminal-background`,
`--terminal-foreground`, `--terminal-muted`, `--terminal-border`,
`--terminal-hover`, `--negative`, and `--font-mono` variables and includes
standalone fallbacks.
