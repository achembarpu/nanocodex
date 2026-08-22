import type { ComponentProps } from "react";
import type { DefaultAgent } from "nanocodex";
import { Transport, type AgentStatus } from "nanocodex/browser";
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
void config.prepareAgent({ threadId: "thread-1" });
const snapshot = config.getAgent();
if (snapshot.status === "success") {
  const agent: DefaultAgent = snapshot.data;
  const error: undefined = snapshot.error;
  void agent;
  void error;
} else {
  const agent: undefined = snapshot.data;
  void agent;
}
// @ts-expect-error the application owns exactly one explicit Config lifecycle.
const missingConfig: ComponentProps<typeof NanocodexProvider> = { children: null };
void missingConfig;
// @ts-expect-error undefined does not transfer Config lifecycle ownership to the provider.
const undefinedConfig: ComponentProps<typeof NanocodexProvider> = { children: null, config: undefined };
void undefinedConfig;

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

function SelectedConsumer() {
  const selectedStatus: AgentStatus = useAgent({
    selector: (resource) => resource.status,
    equalityFn(previous, next) {
      const previousStatus: AgentStatus = previous;
      const nextStatus: AgentStatus = next;
      return previousStatus === nextStatus;
    },
  });
  const sessionId: string | undefined = useAgent({
    selector: (resource) => resource.data?.sessionId,
  });
  const fullResource: UseAgentReturnType = useAgent({
    equalityFn: (previous, next) => previous.status === next.status,
  });
  return selectedStatus === "success" ? sessionId : fullResource.data?.sessionId;
}
void SelectedConsumer;

function narrowResource(resource: UseAgentReturnType) {
  if (resource.status === "success") {
    const data: DefaultAgent = resource.data;
    const error: undefined = resource.error;
    const isSuccess: true = resource.isSuccess;
    const isError: false = resource.isError;
    void data;
    void error;
    void isSuccess;
    void isError;
  } else {
    const data: undefined = resource.data;
    void data;
  }

  if (resource.isError) {
    const status: "error" = resource.status;
    const data: undefined = resource.data;
    const isIdle: false = resource.isIdle;
    void status;
    void data;
    void isIdle;
  }

  if (resource.isPending) {
    const status: "pending" = resource.status;
    const data: undefined = resource.data;
    const error: undefined = resource.error;
    void status;
    void data;
    void error;
  }
}
void narrowResource;

// @ts-expect-error function-backed transports require nanocodex/host and cannot configure the Worker store.
createConfig({ agent: { transport: Transport.hostManaged({ createWebSocket() { return {} as WebSocket; } }) } });
