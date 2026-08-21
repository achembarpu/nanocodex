import type { ComponentProps } from "react";
import { Transport } from "nanocodex/browser";
import {
  NanocodexProvider,
  createConfig,
  useAgent,
  useAgentEvents,
  useConfig,
  type UseAgentReturnType,
} from "../index.mjs";

const config = createConfig({
  agent: { transport: Transport.hostManaged(), thinking: "high" },
  retry: 1,
});
const provider: ComponentProps<typeof NanocodexProvider> = { children: null, config };
void provider;
// @ts-expect-error the application owns exactly one explicit Config lifecycle.
const missingConfig: ComponentProps<typeof NanocodexProvider> = { children: null };
void missingConfig;

function Consumer() {
  const resolved = useConfig();
  const result: UseAgentReturnType = useAgent({
    config: resolved,
    enabled: true,
    threadId: "thread-1",
  });
  useAgentEvents(result.data, (event) => event.seq, { includeAllSessions: true });
  result.refetch();
  return result.data;
}
void Consumer;

// @ts-expect-error function-backed transports require nanocodex/host and cannot configure the Worker store.
createConfig({ agent: { transport: Transport.hostManaged({ createWebSocket() { return {} as WebSocket; } }) } });
