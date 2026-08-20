# nanocodex-terminal

Attach one retained Nanocodex agent to any terminal renderer. The adapter owns
ANSI presentation, line input, prompt history, steering, and cancellation. The
caller still owns the agent, tools, transport, persistence, and shutdown.

```js
import { Agent, Transport } from "nanocodex/browser";
import { createAgentTerminal, xtermAdapter } from "nanocodex-terminal";
import { Terminal } from "@xterm/xterm";

const agent = await Agent.create({
  transport: Transport.openAi({ apiKey }),
});
const xterm = new Terminal();
xterm.open(document.querySelector("#terminal"));

const terminal = createAgentTerminal({
  agent,
  terminal: xtermAdapter(xterm),
});

await terminal.ready;
// Later: terminal.dispose(); await agent.session.shutdown();
```

`TerminalHost` is deliberately small: `write`, `onData`, `onResize`, `cols`,
and `rows`. `xtermAdapter()` and `wtermAdapter()` cover the common web
renderers; native PTYs, headless tests, WebSockets, and other UI frameworks can
implement the same contract directly.
